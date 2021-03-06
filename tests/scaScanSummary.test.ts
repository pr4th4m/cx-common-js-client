import { ScaSummaryEvaluator } from "../src/services/scaSummaryEvaluator";
import { ScaConfig, ScanResults } from "../src";
import { ScanConfig } from "../src";
import { SastConfig } from "../src";
import { Logger } from "../src";
import * as assert from "assert";
import * as fs from 'fs';
import { SourceLocationType } from '../src';
import { RemoteRepositoryInfo } from '../src';
import { CxClient } from '../src';
import * as os from 'os';

describe("Sca Scan Summary", () => {
    it('should return threshold errors in summary', () => {
        const config = getScaConfig();
        config.vulnerabilityThreshold = true;
        config.highThreshold = 1;
        config.mediumThreshold = 5;
        config.lowThreshold = 10;

        const target = new ScaSummaryEvaluator(config);

        const vulResults = {
            highResults: 3,
            mediumResults: 8,
            lowResults: 4
        };
        const summary = target.getScanSummary(vulResults);

        assert.ok(summary.hasThresholdErrors());
        assert.equal(summary.thresholdErrors.length, 2);
    });

    it('should not return threshold errors if all values are below thresholds', () => {
        const config = getScaConfig();
        config.vulnerabilityThreshold = true;
        config.highThreshold = 10;
        config.mediumThreshold = 15;
        config.lowThreshold = 20;

        const target = new ScaSummaryEvaluator(config);

        const vulResults = {
            highResults: 2,
            mediumResults: 11,
            lowResults: 18
        };
        const summary = target.getScanSummary(vulResults);

        assert.ok(!summary.hasThresholdErrors());
        assert.equal(summary.thresholdErrors.length, 0);
    });
});

describe("Sca Scan On Remote Source", () => {

    const cxClient: CxClient = new CxClient(getDummyLogger());
    const config: ScanConfig = getScanConfig();
    config.projectName = 'ScaUnitTest';
    const scaConfig = config.scaConfig;
    if (scaConfig && scaConfig.remoteRepositoryInfo) {
        scaConfig.remoteRepositoryInfo.url = 'https://github.com/margaritalm/SastAndOsaSource.git';
    }

    it('should return results when running on sync mode', async () => {
        config.isSyncMode = true;
        const scanResults: ScanResults = await cxClient.scan(config);
        const scaResults = scanResults.scaResults;
        assert.equal(scanResults.syncMode, true);
        assert.ok(scaResults);
        if (scaResults) {
            assert.equal(scaResults.resultReady, true);
            assert.notEqual(scaResults.highVulnerability, 0);
            assert.notEqual(scaResults.mediumVulnerability, 0);
            assert.notEqual(scaResults.lowVulnerability, 0);
        }
    });

    it('should not return results when running on async mode', async () => {
        config.isSyncMode = false;
        const scanResults: ScanResults = await cxClient.scan(config);
        assert.equal(scanResults.syncMode, false);
        assert.ok(!scanResults.scaResults);
    });
});

describe('Sca Scan On Local Source', () => {

    let cxClient: CxClient;
    let config: ScanConfig;

    beforeEach(() => {
        cxClient = new CxClient(getDummyLogger());
        config = getScanConfig();

        config.projectName = 'ScaUnitTestLocal';
        config.scaConfig!.sourceLocationType = SourceLocationType.LOCAL_DIRECTORY;
        //---------------------------------------------------------------------------//
        // Set the following attribute if you want to debug finger print file.
        config.scaConfig!.fingerprintsFilePath = '';
        //---------------------------------------------------------------------------//
        //---------------------------------------------------------------------------//
        // You need to specify an absolute path for a project on your local machine that
        // you would like to scan.
        // If you don't have one, you can use this git project:
        // https://github.com/CSPF-Founder/JavaVulnerableLab
        config.sourceLocation = '';
        //---------------------------------------------------------------------------//
    });

    it('should return results when running on sync mode', async () => {
        config.isSyncMode = true;

        const scanResults: ScanResults = await cxClient.scan(config);
        const scaResults = scanResults.scaResults;

        assert.equal(scanResults.syncMode, true);
        assert.ok(scaResults);

        if (scaResults) {
            assert.equal(scaResults.resultReady, true);
        }
    });

    it('should not return results when running on async mode', async () => {
        config.isSyncMode = false;

        const scanResults: ScanResults = await cxClient.scan(config);

        assert.equal(scanResults.syncMode, false);
        assert.ok(!scanResults.scaResults);
    });

    it('should send all source files to scan', async () => {
        config.scaConfig!.includeSource = true;

        const scanResults: ScanResults = await cxClient.scan(config);

        assert.equal(scanResults.syncMode, false);
        assert.ok(!scanResults.scaResults);
    });

    it('should save fingerprints file', async () => {
        //---------------------------------------------------------------------------//
        // TODO set this attribute before running test
        config.scaConfig!.fingerprintsFilePath = '';
        //---------------------------------------------------------------------------//

        await cxClient.scan(config);

        assert.ok(fs.existsSync(`${ config.scaConfig!.fingerprintsFilePath }\\CxSCAFingerprints.json`));
    });

    it('should not scan if location does not exists inside sourceFolder', async () => {
        //---------------------------------------------------------------------------//
        // TODO set this attribute before running test
        // Set to location without manifest file
        config.scaConfig!.dependencyFileExtension = '';
        //---------------------------------------------------------------------------//

        await (async () => {
            let f = () => {};

            try {
                await cxClient.scan(config);
            } catch (e) {
                f = () => {throw e;};
            } finally {
                assert.throws(f);
            }
        })();
    });

    it('should send only fingerprints file if manifests are not inside folder', async () => {
        //---------------------------------------------------------------------------//
        // TODO set this attribute before running test
        // Set to location without manifest file
        config.scaConfig!.dependencyFileExtension = '';
        //---------------------------------------------------------------------------//
        config.isSyncMode = true;

        const scanResults: ScanResults = await cxClient.scan(config);
        const scaResults = scanResults.scaResults;

        assert.ok(scaResults);
    });

    it('should not save fingerprints file if fingerprintsFilePath is not set', async () => {
        await cxClient.scan(config);

        try {
            if (fs.existsSync(`${ os.tmpdir() }\\.cxsca.sig`)) {
                assert.ok(false);
            }
        } catch (err) {
            assert.ok(true);
        }
    });

    it('should throw if includeSource & fingerprintsFilePath both exists', async () => {
        //---------------------------------------------------------------------------//
        // TODO set this attribute before running test
        config.scaConfig!.fingerprintsFilePath = '';
        //---------------------------------------------------------------------------//
        config.scaConfig!.includeSource = true;

        await (async () => {
            let f = () => {};

            try {
                await cxClient.scan(config);
            } catch (e) {
                f = () => {throw e;};
            } finally {
                assert.throws(f);
            }
        })();
    });
});

function getScanConfig(): ScanConfig {
    return {
        sourceLocation: "",
        projectName: "",
        enableSastScan: false,
        enableDependencyScan: true,
        cxOrigin: "JsCommon",
        sastConfig: getSastConfig(),
        scaConfig: getScaConfig(),
        isSyncMode: false
    };
}

function getScaConfig(): ScaConfig {
    const remoteRepositoryInfo: RemoteRepositoryInfo = new RemoteRepositoryInfo();
    remoteRepositoryInfo.url = '';

    return {
        //---------------------------------------------------------------------------//
        // The following attributes are not populated because they are sensitive.
        // To make relevant tests work, you need to populate them locally only.
        // Please don't commit them to github.
        apiUrl: '',
        accessControlUrl: '',
        username: '',
        password: '',
        tenant: '',
        webAppUrl: '',
        //---------------------------------------------------------------------------//
        sourceLocationType: SourceLocationType.REMOTE_REPOSITORY,
        remoteRepositoryInfo: remoteRepositoryInfo,
        dependencyFileExtension: '',
        dependencyFolderExclusion: '',
        vulnerabilityThreshold: false
    };
}

function getSastConfig(): SastConfig {
    return {
        username: "",
        password: "",
        teamName: "",
        teamId: 0,
        serverUrl: "",
        isPublic: false,
        denyProject: false,
        folderExclusion: "",
        fileExtension: "",
        isIncremental: false,
        forceScan: false,
        comment: "",
        presetName: "",
        presetId: 0,
        scanTimeoutInMinutes: 0,
        enablePolicyViolations: false,
        vulnerabilityThreshold: false,
        highThreshold: 0,
        mediumThreshold: 0,
        lowThreshold: 0
    };
}

function getDummyLogger(): Logger {
    return {
        debug(message: string) {
            console.debug(message);
        },
        error(message: string) {
            console.error(message);
        },
        info(message: string) {
            console.info(message);
        },
        warning(message: string) {
            console.warn(message);
        }
    };
}
