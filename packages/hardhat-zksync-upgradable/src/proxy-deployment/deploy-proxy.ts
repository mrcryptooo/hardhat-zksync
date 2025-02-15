import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as zk from 'zksync-ethers';
import chalk from 'chalk';
import path from 'path';
import { BeaconProxyUnsupportedError } from '@openzeppelin/upgrades-core';

import { ZkSyncArtifact } from '@matterlabs/hardhat-zksync-deploy/src/types';

import assert from 'assert';
import { getInitializerData } from '../utils/utils-general';
import { ERC1967_PROXY_JSON, TUP_JSON } from '../constants';
import { Manifest, ProxyDeployment } from '../core/manifest';
import { DeployProxyOptions } from '../utils/options';
import { ZkSyncUpgradablePluginError } from '../errors';
import { deployProxyImpl } from './deploy-impl';
import { DeployTransaction, deploy } from './deploy';

export type DeployFunction = (
    wallet: zk.Wallet,
    artifact: ZkSyncArtifact,
    args?: unknown[],
    opts?: DeployProxyOptions,
    quiet?: boolean,
) => Promise<zk.Contract>;

export function makeDeployProxy(hre: HardhatRuntimeEnvironment): DeployFunction {
    return async function deployProxy(
        wallet,
        artifact,
        args: unknown[] | DeployProxyOptions = [],
        opts: DeployProxyOptions = {},
        quiet: boolean = false,
    ): Promise<zk.Contract> {
        if (!Array.isArray(args)) {
            opts = args;
            args = [];
        }
        opts.provider = wallet.provider;
        const manifest = await Manifest.forNetwork(wallet.provider);

        const factory = new zk.ContractFactory<any[], zk.Contract>(artifact.abi, artifact.bytecode, wallet);
        const { impl, kind } = await deployProxyImpl(hre, factory, opts);
        if (!quiet) {
            console.info(chalk.green(`Implementation contract was deployed to ${impl}`));
        }

        const data = getInitializerData(factory.interface, args, opts.initializer);

        if (kind === 'uups') {
            if (await manifest.getAdmin()) {
                if (!quiet) {
                    console.info(
                        chalk.yellow(
                            `A proxy admin was previously deployed on this network\nThis is not natively used with the current kind of proxy ('uups')\nChanges to the admin will have no effect on this new proxy`,
                        ),
                    );
                }
            }
        }

        let proxyDeployment: Required<ProxyDeployment & DeployTransaction>;
        switch (kind) {
            case 'beacon': {
                throw new BeaconProxyUnsupportedError();
            }

            case 'uups': {
                const ERC1967ProxyPath = (await hre.artifacts.getArtifactPaths()).find((x) =>
                    x.includes(path.sep + ERC1967_PROXY_JSON),
                );
                assert(ERC1967ProxyPath, 'ERC1967Proxy artifact not found');
                const proxyContract = await import(ERC1967ProxyPath);
                const proxyFactory = new zk.ContractFactory(proxyContract.abi, proxyContract.bytecode, wallet);
                proxyDeployment = { kind, ...(await deploy(proxyFactory, impl, data)) };

                if (!quiet) {
                    console.info(chalk.green(`UUPS proxy was deployed to ${proxyDeployment.address}`));
                }
                break;
            }

            case 'transparent': {
                const adminAddress = await hre.zkUpgrades.deployProxyAdmin(wallet, {});
                if (!quiet) {
                    console.info(chalk.green(`Admin was deployed to ${adminAddress}`));
                }

                const TUPPath = (await hre.artifacts.getArtifactPaths()).find((x) => x.includes(path.sep + TUP_JSON));
                assert(TUPPath, 'TUP artifact not found');
                const TUPContract = await import(TUPPath);

                const TUPFactory = new zk.ContractFactory(TUPContract.abi, TUPContract.bytecode, wallet);
                proxyDeployment = { kind, ...(await deploy(TUPFactory, impl, adminAddress, data)) };

                if (!quiet) {
                    console.info(chalk.green(`Transparent proxy was deployed to ${proxyDeployment.address}`));
                }

                break;
            }

            default: {
                throw new ZkSyncUpgradablePluginError(`Unknown proxy kind: ${kind}`);
            }
        }

        await manifest.addProxy(proxyDeployment);
        const inst = factory.attach(proxyDeployment.address);
        // @ts-ignore Won't be readonly because inst was created through attach.
        inst.deployTransaction = proxyDeployment.deployTransaction;
        return inst;
    };
}
