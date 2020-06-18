import { Logger, ScaConfig } from "../..";
import { HttpClient } from "./httpClient";
import { Stopwatch } from "../stopwatch";
import { ScaLoginSettings } from "../../dto/sca/scaLoginSettings";
import { SCAResults } from "../../dto/sca/scaResults";
import { ScaSummaryResults } from "../../dto/sca/report/scaSummaryResults";
import { Project } from "../../dto/sca/project";
import { ClientType } from '../../dto/sca/clientType';
import { Finding } from "../../dto/sca/report/finding";
import { Package } from "../../dto/sca/report/package";
import { ScanResults } from '../../dto/scanResults';
import { SCAWaiter } from '../scaWaiter';
import { SourceLocationType } from '../../dto/sca/sourceLocationType';
import { tmpNameSync } from "tmp";
import { FilePathFilter } from "../filePathFilter";
import Zipper from "../zipper";
import { TaskSkippedError } from "../../dto/taskSkippedError";
import { RemoteRepositoryInfo } from '../../dto/sca/remoteRepositoryInfo';
import { ScaReportResults } from '../../dto/sca/scaReportResults';
import * as url from "url";

/**
 * SCA - Software Composition Analysis - is the successor of OSA.
 */
export class ScaClient {
    public static readonly TENANT_HEADER_NAME: string = "Account-Name";
    public static readonly AUTHENTICATION: string = "identity/connect/token";

    private static readonly RISK_MANAGEMENT_API: string = "/risk-management/";
    private static readonly PROJECTS: string = ScaClient.RISK_MANAGEMENT_API + "projects";
    private static readonly SUMMARY_REPORT: string = ScaClient.RISK_MANAGEMENT_API + "riskReports/%s/summary";
    private static readonly REPORT_ID: string = ScaClient.RISK_MANAGEMENT_API + "scans/%s/riskReportId";

    private static readonly ZIP_UPLOAD: string = "/api/uploads";
    private static readonly CREATE_SCAN: string = "/api/scans";
    private static readonly GET_SCAN: string = "/api/scans/%s";
    private static readonly WEB_REPORT: string = "/#/projects/%s/reports/%s";

    private static readonly CLOUD_ACCESS_CONTROL_BASE_URL: string = "https://platform.checkmarx.net";

    private projectId: string = '';
    private scanId: string = '';

    private readonly stopwatch = new Stopwatch();

    constructor(private readonly config: ScaConfig,
        private readonly sourceLocation: string,
        private readonly httpClient: HttpClient,
        private readonly log: Logger) {
    }

    private resolveScaLoginSettings(scaConfig: ScaConfig): ScaLoginSettings {
        const settings: ScaLoginSettings = new ScaLoginSettings();

        let acUrl: string = scaConfig.accessControlUrl;
        let isAccessControlInCloud: boolean = false;

        if (acUrl && acUrl.startsWith(ScaClient.CLOUD_ACCESS_CONTROL_BASE_URL)) {
            isAccessControlInCloud = true;
        }
        else {
            acUrl = url.resolve(acUrl, 'CxRestAPI/auth/');
        }
        this.log.info(isAccessControlInCloud ? "Using cloud authentication." : "Using on-premise authentication.");

        settings.apiUrl = scaConfig.apiUrl;
        settings.accessControlBaseUrl = acUrl;
        settings.username = scaConfig.username;
        settings.password = scaConfig.password;
        settings.tenant = scaConfig.tenant;

        const clientType: ClientType = isAccessControlInCloud ? ClientType.SCA : ClientType.RESOURCE_OWNER;
        settings.clientTypeForPasswordAuth = clientType;

        return settings;
    }

    public async scaLogin(scaConfig: ScaConfig) {
        this.log.info("Logging into CxSCA.");
        const settings: ScaLoginSettings = this.resolveScaLoginSettings(scaConfig);
        await this.httpClient.scaLogin(settings);
    }

    public async resolveProject(projectName: string) {
        this.log.info("Resolving project by name: " + projectName);
        await this.getProjectIdByName(projectName);
        if (!this.projectId) {
            this.log.info("Project not found, creating a new one.");
            this.projectId = await this.createProject(projectName);
            this.log.info("Created a project with ID: " + this.projectId);
        }
        else {
            this.log.info("Project already exists with ID: " + this.projectId);
        }
    }

    private async getProjectIdByName(projectName: string) {
        if (!projectName || projectName === '') {
            throw Error("Non-empty project name must be provided.");
        }

        const allProjects: Project[] = await this.getAllProjects();
        for (const project of allProjects) {
            if (project.name.match(projectName)) {
                this.projectId = project.id;
                break;
            }
        }
    }

    private async getAllProjects(): Promise<Project[]> {
        return await this.httpClient.getRequest(ScaClient.PROJECTS) as Project[];
    }

    private async createProject(projectName: string): Promise<any> {
        const request = {
            name: projectName
        };
        const newProject = await this.httpClient.postRequest(ScaClient.PROJECTS, request);
        return newProject.id;
    }

    public async createScan() {
        this.log.info("----------------------------------- Creating CxSCA Scan ------------------------------------");
        try {
            const locationType: SourceLocationType = this.config.sourceLocationType;
            let response: any;
            if (locationType === SourceLocationType.REMOTE_REPOSITORY) {
                response = await this.submitSourceFromRemoteRepo();
            } else {
                response = await this.submitSourceFromLocalDir();
            }
            this.scanId = this.extractScanIdFrom(response);
            this.stopwatch.start();
            this.log.info("Scan started successfully. Scan ID: " + this.scanId);
        } catch (err) {
            throw Error("Error creating CxSCA scan. " + err.message);
        }
    }

    private async submitSourceFromRemoteRepo(): Promise<any> {
        this.log.info("Using remote repository flow.");
        const repoInfo: RemoteRepositoryInfo | undefined = this.config.remoteRepositoryInfo;
        if (!repoInfo) {
            throw Error(`URL must be provided in CxSCA configuration when using source location of type ${SourceLocationType.REMOTE_REPOSITORY}.`);
        }
        return await this.sendStartScanRequest(SourceLocationType.REMOTE_REPOSITORY, repoInfo.url);
    }

    private async getSourceUploadUrl(): Promise<string> {
        const response: any = await this.httpClient.postRequest(ScaClient.ZIP_UPLOAD, {});
        if (!response || !response["url"]) {
            throw Error("Unable to get the upload URL.");
        }
        return response["url"];
    }

    private async submitSourceFromLocalDir(): Promise<any> {
        this.log.info("Using local directory flow.");
        const tempFilename = tmpNameSync({ prefix: 'cxsrc-', postfix: '.zip' });
        this.log.info(`Zipping source code at ${this.sourceLocation} into file ${tempFilename}`);
        const filter: FilePathFilter = new FilePathFilter(this.config.dependencyFileExtension, this.config.dependencyFolderExclusion);
        const zipper = new Zipper(this.log, filter);
        const zipResult = await zipper.zipDirectory(this.sourceLocation, tempFilename);
        if (zipResult.fileCount === 0) {
            throw new TaskSkippedError('Zip file is empty: no source to scan');
        }
        this.log.info("Uploading the zipped source file...");
        const uploadedArchiveUrl: string = await this.getSourceUploadUrl();
        await this.uploadToAWS(uploadedArchiveUrl, tempFilename);
        return await this.sendStartScanRequest(SourceLocationType.LOCAL_DIRECTORY, uploadedArchiveUrl);
    }

    private async uploadToAWS(url: string, file: string) {
        this.log.debug(`Sending PUT request to ${url}`);
        const child_process = require('child_process');
        const command = `curl -X PUT -L "${url}" -H "Content-Type:" -T "${file}"`;
        child_process.execSync(command);
    }

    private async sendStartScanRequest(sourceLocation: SourceLocationType, sourceUrl: string): Promise<any> {
        this.log.info("Sending a request to start scan.");
        const request = {
            project: {
                id: this.projectId,
                type: sourceLocation,
                handler: {
                    url: sourceUrl
                }
            }
        };
        return await this.httpClient.postRequest(ScaClient.CREATE_SCAN, request);
    }

    private extractScanIdFrom(response: any): string {
        if (response && response["id"]) {
            return response["id"];
        }
        throw Error('Unable to get scan ID.');
    }

    public async waitForScanResults(result: ScanResults) {
        this.log.info("------------------------------------ Get CxSCA Results -----------------------------------");
        const waiter: SCAWaiter = new SCAWaiter(this.scanId, this.httpClient, this.stopwatch, this.log);
        await waiter.waitForScanToFinish();
        const scaResults: SCAResults = await this.retrieveScanResults();
        const scaReportResults: ScaReportResults = new ScaReportResults(scaResults);
        result.scaResults = scaReportResults;
    }

    private async retrieveScanResults(): Promise<SCAResults> {
        this.log.info("Retrieving CxSCA scan results.");
        try {
            const reportId: string = await this.getReportId();
            const result: SCAResults = new SCAResults();
            result.scanId = this.scanId;
            const scanSummary: ScaSummaryResults = await this.getSummaryReport(reportId);
            result.summary = scanSummary;
            const findings: Finding[] = await this.getFindings(reportId);
            result.findings = findings;
            const packages: Package[] = await this.getPackages(reportId);
            result.packages = packages;
            const reportLink: string = this.getWebReportLink(reportId);
            result.webReportLink = reportLink;
            if (reportLink) {
                this.log.info("CxSCA scan results location: " + reportLink);
            }
            result.scaResultReady = true;
            this.log.info("Retrieved CxSCA results successfully.");
            return result;
        }
        catch (err) {
            throw Error("Error retrieving CxSCA scan results. " + err.message);
        }
    }

    private getWebReportLink(reportId: string): string {
        const MESSAGE = "Unable to generate web report link. ";
        let result: string = '';
        try {
            const webAppUrl: string = this.config.webAppUrl;
            if (!webAppUrl || webAppUrl === '') {
                this.log.warning(MESSAGE + "Web app URL is not specified.");
            } else {
                result = `${webAppUrl}/#/projects/${this.projectId}/reports/${reportId}`;
            }
        } catch (err) {
            this.log.warning(MESSAGE + err);
        }
        return result;
    }

    private async getSummaryReport(reportId: string): Promise<ScaSummaryResults> {
        this.log.debug("Getting summary report.");
        const result: ScaSummaryResults = await this.httpClient.getRequest(`/risk-management/riskReports/${reportId}/summary`) as ScaSummaryResults;
        this.printSummaryResult(result);
        return result;
    }

    private printSummaryResult(summary: ScaSummaryResults) {
        this.log.info("\n----CxSCA risk report summary----");
        this.log.info("Created on: " + summary.createdOn);
        this.log.info("Direct packages: " + summary.directPackages);
        this.log.info("High vulnerabilities: " + summary.highVulnerabilityCount);
        this.log.info("Medium vulnerabilities: " + summary.mediumVulnerabilityCount);
        this.log.info("Low vulnerabilities: " + summary.lowVulnerabilityCount);
        this.log.info("Risk report ID: " + summary.riskReportId);
        this.log.info("Scan ID: " + this.scanId);
        this.log.info("Risk score: " + summary.riskScore);
        this.log.info("Total packages: " + summary.totalPackages);
        this.log.info("Total outdated packages: " + summary.totalOutdatedPackages + '\n');
    }

    private async getFindings(reportId: string): Promise<Finding[]> {
        this.log.info("Getting findings.");
        const findings: Finding[] = await this.httpClient.getRequest(`/risk-management/riskReports/${reportId}/vulnerabilities`);
        return findings;
    }

    private async getPackages(reportId: string): Promise<Package[]> {
        this.log.info("Getting packages.");
        const packages: Package[] = await this.httpClient.getRequest(`/risk-management/riskReports/${reportId}/packages`);
        return packages;
    }

    private async getReportId(): Promise<string> {
        this.log.debug("Getting report ID by scan ID: " + this.scanId);
        const reportId: string = await this.httpClient.getRequest(`/risk-management/scans/${this.scanId}/riskReportId`);
        this.log.info("Report ID is: " + reportId);
        return reportId;
    }
}