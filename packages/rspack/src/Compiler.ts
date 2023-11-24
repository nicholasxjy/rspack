/**
 * The following code is modified based on
 * https://github.com/webpack/webpack/blob/4b4ca3bb53f36a5b8fc6bc1bd976ed7af161bd80/lib/Compiler.js
 *
 * MIT Licensed
 * Author Tobias Koppers @sokra
 * Copyright (c) JS Foundation and other contributors
 * https://github.com/webpack/webpack/blob/main/LICENSE
 */
import type * as binding from "@rspack/binding";
import { rspack } from "./index";
import fs from "fs";
import * as tapable from "tapable";
import { Callback, SyncBailHook, SyncHook } from "tapable";
import type { WatchOptions } from "watchpack";
import {
	EntryNormalized,
	OutputNormalized,
	RspackOptionsNormalized,
	RspackPluginInstance
} from "./config";
import { RuleSetCompiler } from "./RuleSetCompiler";
import { Stats } from "./Stats";
import { Compilation, CompilationParams } from "./Compilation";
import { ContextModuleFactory } from "./ContextModuleFactory";
import ResolverFactory from "./ResolverFactory";
import { getRawOptions } from "./config";
import { LoaderContext, LoaderResult } from "./config/adapterRuleUse";
import ConcurrentCompilationError from "./error/ConcurrentCompilationError";
import { createThreadsafeNodeFSFromRaw } from "./fileSystem";
import Cache from "./lib/Cache";
import CacheFacade from "./lib/CacheFacade";
import ModuleFilenameHelpers from "./lib/ModuleFilenameHelpers";
import { runLoaders } from "./loader-runner";
import { Logger } from "./logging/Logger";
import { NormalModuleFactory } from "./NormalModuleFactory";
import { WatchFileSystem } from "./util/fs";
import { getScheme } from "./util/scheme";
import { checkVersion } from "./util/bindingVersionCheck";
import { Watching } from "./Watching";
import { NormalModule } from "./NormalModule";
import { normalizeJsModule } from "./util/normalization";
import {
	RspackBuiltinPlugin,
	deprecated_resolveBuiltins
} from "./builtin-plugin";
import { optionsApply_compat } from "./rspackOptionsApply";
import { applyRspackOptionsDefaults } from "./config/defaults";
import { assertNotNill } from "./util/assertNotNil";
import { FileSystemInfoEntry } from "./FileSystemInfo";
import { RuntimeGlobals } from "./RuntimeGlobals";
import { tryRunOrWebpackError } from "./lib/HookWebpackError";
import { CodeGenerationResult } from "./Module";

class Compiler {
	#_instance?: binding.Rspack;

	webpack = rspack;
	// @ts-expect-error
	compilation: Compilation;
	builtinPlugins: binding.BuiltinPlugin[];
	root: Compiler;
	running: boolean;
	idle: boolean;
	resolverFactory: ResolverFactory;
	infrastructureLogger: any;
	watching?: Watching;
	outputPath!: string;
	name?: string;
	inputFileSystem: any;
	outputFileSystem: typeof import("fs");
	ruleSet: RuleSetCompiler;
	// @ts-expect-error
	watchFileSystem: WatchFileSystem;
	intermediateFileSystem: any;
	// @ts-expect-error
	watchMode: boolean;
	context: string;
	modifiedFiles?: ReadonlySet<string>;
	cache: Cache;
	compilerPath: string;
	removedFiles?: ReadonlySet<string>;
	fileTimestamps?: ReadonlyMap<string, FileSystemInfoEntry | "ignore" | null>;
	contextTimestamps?: ReadonlyMap<
		string,
		FileSystemInfoEntry | "ignore" | null
	>;
	hooks: {
		done: tapable.AsyncSeriesHook<Stats>;
		afterDone: tapable.SyncHook<Stats>;
		// TODO: CompilationParams
		compilation: tapable.SyncHook<[Compilation, CompilationParams]>;
		// TODO: CompilationParams
		thisCompilation: tapable.SyncHook<[Compilation, CompilationParams]>;
		invalid: tapable.SyncHook<[string | null, number]>;
		compile: tapable.SyncHook<[any]>;
		normalModuleFactory: tapable.SyncHook<NormalModuleFactory>;
		contextModuleFactory: tapable.SyncHook<ContextModuleFactory>;
		initialize: tapable.SyncHook<[]>;
		shouldEmit: tapable.SyncBailHook<[Compilation], undefined>;
		infrastructureLog: tapable.SyncBailHook<[string, string, any[]], true>;
		beforeRun: tapable.AsyncSeriesHook<[Compiler]>;
		run: tapable.AsyncSeriesHook<[Compiler]>;
		emit: tapable.AsyncSeriesHook<[Compilation]>;
		assetEmitted: tapable.AsyncSeriesHook<[string, any]>;
		afterEmit: tapable.AsyncSeriesHook<[Compilation]>;
		failed: tapable.SyncHook<[Error]>;
		shutdown: tapable.AsyncSeriesHook<[]>;
		watchRun: tapable.AsyncSeriesHook<[Compiler]>;
		watchClose: tapable.SyncHook<[]>;
		environment: tapable.SyncHook<[]>;
		afterEnvironment: tapable.SyncHook<[]>;
		afterPlugins: tapable.SyncHook<[Compiler]>;
		afterResolvers: tapable.SyncHook<[Compiler]>;
		make: tapable.AsyncParallelHook<[Compilation]>;
		beforeCompile: tapable.AsyncSeriesHook<any>;
		afterCompile: tapable.AsyncSeriesHook<[Compilation]>;
		finishModules: tapable.AsyncSeriesHook<[any]>;
		finishMake: tapable.AsyncSeriesHook<[Compilation]>;
		entryOption: tapable.SyncBailHook<[string, EntryNormalized], any>;
	};
	options: RspackOptionsNormalized;
	#disabledHooks: string[];
	parentCompilation?: Compilation;

	constructor(context: string, options: RspackOptionsNormalized) {
		this.outputFileSystem = fs;
		this.options = options;
		this.cache = new Cache();
		this.compilerPath = "";
		this.builtinPlugins = [];
		this.root = this;
		this.ruleSet = new RuleSetCompiler();
		this.running = false;
		this.idle = false;
		this.context = context;
		this.resolverFactory = new ResolverFactory();
		this.modifiedFiles = undefined;
		this.removedFiles = undefined;
		this.hooks = {
			initialize: new SyncHook([]),
			shouldEmit: new tapable.SyncBailHook(["compilation"]),
			done: new tapable.AsyncSeriesHook<Stats>(["stats"]),
			afterDone: new tapable.SyncHook<Stats>(["stats"]),
			beforeRun: new tapable.AsyncSeriesHook(["compiler"]),
			run: new tapable.AsyncSeriesHook(["compiler"]),
			emit: new tapable.AsyncSeriesHook(["compilation"]),
			assetEmitted: new tapable.AsyncSeriesHook(["file", "info"]),
			afterEmit: new tapable.AsyncSeriesHook(["compilation"]),
			thisCompilation: new tapable.SyncHook<[Compilation, CompilationParams]>([
				"compilation",
				"params"
			]),
			compilation: new tapable.SyncHook<[Compilation, CompilationParams]>([
				"compilation",
				"params"
			]),
			invalid: new SyncHook(["filename", "changeTime"]),
			compile: new SyncHook(["params"]),
			infrastructureLog: new SyncBailHook(["origin", "type", "args"]),
			failed: new SyncHook(["error"]),
			shutdown: new tapable.AsyncSeriesHook([]),
			normalModuleFactory: new tapable.SyncHook<NormalModuleFactory>([
				"normalModuleFactory"
			]),
			contextModuleFactory: new tapable.SyncHook<ContextModuleFactory>([
				"contextModuleFactory"
			]),
			watchRun: new tapable.AsyncSeriesHook(["compiler"]),
			watchClose: new tapable.SyncHook([]),
			environment: new tapable.SyncHook([]),
			afterEnvironment: new tapable.SyncHook([]),
			afterPlugins: new tapable.SyncHook(["compiler"]),
			afterResolvers: new tapable.SyncHook(["compiler"]),
			make: new tapable.AsyncParallelHook(["compilation"]),
			beforeCompile: new tapable.AsyncSeriesHook(["params"]),
			afterCompile: new tapable.AsyncSeriesHook(["compilation"]),
			finishMake: new tapable.AsyncSeriesHook(["compilation"]),
			finishModules: new tapable.AsyncSeriesHook(["modules"]),
			entryOption: new tapable.SyncBailHook(["context", "entry"])
		};
		this.modifiedFiles = undefined;
		this.removedFiles = undefined;
		this.#disabledHooks = [];
	}

	/**
	 * @param {string} name cache name
	 * @returns {CacheFacade} the cache facade instance
	 */
	getCache(name: string): CacheFacade {
		return new CacheFacade(
			this.cache,
			`${this.compilerPath}${name}`,
			this.options.output.hashFunction
		);
	}

	/**
	 * Lazy initialize instance so it could access the changed options
	 */
	#getInstance(
		callback: (error: Error | null, instance?: binding.Rspack) => void
	): void {
		const error = checkVersion();
		if (error) {
			return callback(error);
		}

		if (this.#_instance) {
			return callback(null, this.#_instance);
		}

		const processResource = (
			loaderContext: LoaderContext,
			resourcePath: string,
			callback: any
		) => {
			const resource = loaderContext.resource;
			const scheme = getScheme(resource);
			this.compilation
				.currentNormalModuleHooks()
				.readResource.for(scheme)
				.callAsync(loaderContext, (err: any, result: LoaderResult) => {
					if (err) return callback(err);
					if (typeof result !== "string" && !result) {
						return callback(new Error(`Unhandled ${scheme} resource`));
					}
					return callback(null, result);
				});
		};

		const options = this.options;
		// TODO: remove this in v0.4
		optionsApply_compat(this, options);
		// TODO: remove this when drop support for builtins options
		options.builtins = deprecated_resolveBuiltins(
			options.builtins,
			options,
			this
		) as any;
		const rawOptions = getRawOptions(options, this, processResource);

		const instanceBinding: typeof binding = require("@rspack/binding");

		this.#_instance = new instanceBinding.Rspack(
			rawOptions,
			this.builtinPlugins,
			{
				beforeCompile: this.#beforeCompile.bind(this),
				afterCompile: this.#afterCompile.bind(this),
				finishMake: this.#finishMake.bind(this),
				make: this.#make.bind(this),
				shouldEmit: this.#shouldEmit.bind(this),
				emit: this.#emit.bind(this),
				assetEmitted: this.#assetEmitted.bind(this),
				afterEmit: this.#afterEmit.bind(this),
				processAssetsStageAdditional: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
				),
				processAssetsStagePreProcess: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS
				),
				processAssetsStageDerived: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_DERIVED
				),
				processAssetsStageAdditions: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_ADDITIONS
				),
				processAssetsStageNone: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_NONE
				),
				processAssetsStageOptimize: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE
				),
				processAssetsStageOptimizeCount: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT
				),
				processAssetsStageOptimizeCompatibility: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY
				),
				processAssetsStageOptimizeSize: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE
				),
				processAssetsStageDevTooling: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING
				),
				processAssetsStageOptimizeInline: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE
				),
				processAssetsStageSummarize: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
				),
				processAssetsStageOptimizeHash: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH
				),
				processAssetsStageOptimizeTransfer: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER
				),
				processAssetsStageAnalyse: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_ANALYSE
				),
				processAssetsStageReport: this.#processAssets.bind(
					this,
					Compilation.PROCESS_ASSETS_STAGE_REPORT
				),
				// `Compilation` should be created with hook `thisCompilation`, and here is the reason:
				// We know that the hook `thisCompilation` will not be called from a child compiler(it doesn't matter whether the child compiler is created on the Rust or the Node side).
				// See webpack's API: https://webpack.js.org/api/compiler-hooks/#thiscompilation
				// So it is safe to create a new compilation here.
				thisCompilation: this.#newCompilation.bind(this),
				// The hook `Compilation` should be called whenever it's a call from the child compiler or normal compiler and
				// still it does not matter where the child compiler is created(Rust or Node) as calling the hook `compilation` is a required task.
				// No matter how it will be implemented, it will be copied to the child compiler.
				compilation: this.#compilation.bind(this),
				optimizeModules: this.#optimizeModules.bind(this),
				optimizeTree: this.#optimizeTree.bind(this),
				optimizeChunkModules: this.#optimizeChunkModules.bind(this),
				finishModules: this.#finishModules.bind(this),
				normalModuleFactoryResolveForScheme:
					this.#normalModuleFactoryResolveForScheme.bind(this),
				chunkAsset: this.#chunkAsset.bind(this),
				beforeResolve: this.#beforeResolve.bind(this),
				afterResolve: this.#afterResolve.bind(this),
				contextModuleBeforeResolve: this.#contextModuleBeforeResolve.bind(this),
				succeedModule: this.#succeedModule.bind(this),
				stillValidModule: this.#stillValidModule.bind(this),
				buildModule: this.#buildModule.bind(this),
				executeModule: this.#executeModule.bind(this)
			},
			createThreadsafeNodeFSFromRaw(this.outputFileSystem),
			runLoaders.bind(undefined, this)
		);

		callback(null, this.#_instance);
	}

	createChildCompiler(
		compilation: Compilation,
		compilerName: string,
		compilerIndex: number,
		outputOptions: OutputNormalized,
		plugins: RspackPluginInstance[]
	): Compiler {
		const options: RspackOptionsNormalized = {
			...this.options,
			output: {
				...this.options.output,
				...outputOptions
			},
			// TODO: check why we need to have builtins otherwise this.#instance will fail to initialize Rspack
			builtins: {
				...this.options.builtins,
				html: undefined
			}
		};
		applyRspackOptionsDefaults(options);
		const childCompiler = new Compiler(this.context, options);
		childCompiler.name = compilerName;
		childCompiler.outputPath = this.outputPath;
		childCompiler.inputFileSystem = this.inputFileSystem;
		// childCompiler.outputFileSystem = null;
		childCompiler.resolverFactory = this.resolverFactory;
		childCompiler.modifiedFiles = this.modifiedFiles;
		childCompiler.removedFiles = this.removedFiles;
		// childCompiler.fileTimestamps = this.fileTimestamps;
		// childCompiler.contextTimestamps = this.contextTimestamps;
		// childCompiler.fsStartTime = this.fsStartTime;
		childCompiler.cache = this.cache;
		childCompiler.compilerPath = `${this.compilerPath}${compilerName}|${compilerIndex}|`;
		// childCompiler._backCompat = this._backCompat;

		// const relativeCompilerName = makePathsRelative(
		// 	this.context,
		// 	compilerName,
		// 	this.root
		// );
		// if (!this.records[relativeCompilerName]) {
		// 	this.records[relativeCompilerName] = [];
		// }
		// if (this.records[relativeCompilerName][compilerIndex]) {
		// 	childCompiler.records = this.records[relativeCompilerName][compilerIndex];
		// } else {
		// 	this.records[relativeCompilerName].push((childCompiler.records = {}));
		// }

		childCompiler.parentCompilation = compilation;
		childCompiler.root = this.root;
		if (Array.isArray(plugins)) {
			for (const plugin of plugins) {
				plugin.apply(childCompiler);
			}
		}
		for (const name in this.hooks) {
			if (
				![
					"make",
					"compile",
					"emit",
					"afterEmit",
					"invalid",
					"done",
					"thisCompilation"
				].includes(name)
			) {
				//@ts-ignore
				if (childCompiler.hooks[name]) {
					//@ts-ignore
					childCompiler.hooks[name].taps = this.hooks[name].taps.slice();
				}
			}
		}

		// compilation.hooks.childCompiler.call(
		// 	childCompiler,
		// 	compilerName,
		// 	compilerIndex
		// );

		return childCompiler;
	}

	runAsChild(callback: any) {
		const finalCallback = (
			err: Error | null,
			entries?: any,
			compilation?: Compilation
		) => {
			try {
				callback(err, entries, compilation);
			} catch (e) {
				const err = new Error(`compiler.runAsChild callback error: ${e}`);
				// err.details = e.stack;
				this.parentCompilation!.errors.push(err);
				// TODO: remove once this works
				console.log(e);
			}
		};

		this.compile((err, compilation) => {
			if (err) {
				return finalCallback(err);
			}

			assertNotNill(compilation);

			this.parentCompilation!.children.push(compilation);
			for (const { name, source, info } of compilation.getAssets()) {
				// Do not emit asset if source is not available.
				// Webpack will emit it anyway.
				if (source) {
					this.parentCompilation!.emitAsset(name, source, info);
				}
			}

			const entries = [];
			for (const ep of compilation.entrypoints.values()) {
				entries.push(...ep.getFiles());
			}

			return finalCallback(null, entries, compilation);
		});
	}

	isChild(): boolean {
		const isRoot = this.root === this;
		return !isRoot;
	}

	getInfrastructureLogger(name: string | Function) {
		if (!name) {
			throw new TypeError(
				"Compiler.getInfrastructureLogger(name) called without a name"
			);
		}
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
						);
					}
				} else {
					if (
						// @ts-expect-error
						this.hooks.infrastructureLog.call(name, type, args) === undefined
					) {
						if (this.infrastructureLogger !== undefined) {
							this.infrastructureLogger(name, type, args);
						}
					}
				}
			},
			(childName): any => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						// @ts-expect-error
						return this.getInfrastructureLogger(_ => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
				} else {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(`${name}/${childName}`);
					}
				}
			}
		);
	}

	#updateDisabledHooks(callback?: (error?: Error) => void) {
		const disabledHooks: string[] = [];
		type HookMap = Record<keyof binding.JsHooks, any>;
		const hookMap: HookMap = {
			make: this.hooks.make,
			beforeCompile: this.hooks.beforeCompile,
			afterCompile: this.hooks.afterCompile,
			finishMake: this.hooks.finishMake,
			shouldEmit: this.hooks.shouldEmit,
			emit: this.hooks.emit,
			assetEmitted: this.hooks.assetEmitted,
			afterEmit: this.hooks.afterEmit,
			processAssetsStageAdditional:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
				),
			processAssetsStagePreProcess:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS
				),
			processAssetsStageDerived:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_DERIVED
				),
			processAssetsStageAdditions:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_ADDITIONS
				),
			processAssetsStageNone:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_NONE
				),
			processAssetsStageOptimize:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE
				),
			processAssetsStageOptimizeCount:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT
				),
			processAssetsStageOptimizeCompatibility:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY
				),
			processAssetsStageOptimizeSize:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE
				),
			processAssetsStageDevTooling:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING
				),
			processAssetsStageOptimizeInline:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE
				),
			processAssetsStageSummarize:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
				),
			processAssetsStageOptimizeHash:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH
				),
			processAssetsStageOptimizeTransfer:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER
				),
			processAssetsStageAnalyse:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_ANALYSE
				),
			processAssetsStageReport:
				this.compilation.__internal_getProcessAssetsHookByStage(
					Compilation.PROCESS_ASSETS_STAGE_REPORT
				),
			compilation: this.hooks.compilation,
			optimizeTree: this.compilation.hooks.optimizeTree,
			finishModules: this.compilation.hooks.finishModules,
			optimizeModules: this.compilation.hooks.optimizeModules,
			chunkAsset: this.compilation.hooks.chunkAsset,
			beforeResolve: this.compilation.normalModuleFactory?.hooks.beforeResolve,
			afterResolve: this.compilation.normalModuleFactory?.hooks.afterResolve,
			succeedModule: this.compilation.hooks.succeedModule,
			stillValidModule: this.compilation.hooks.stillValidModule,
			buildModule: this.compilation.hooks.buildModule,
			thisCompilation: undefined,
			optimizeChunkModules: this.compilation.hooks.optimizeChunkModules,
			contextModuleBeforeResolve: undefined,
			normalModuleFactoryResolveForScheme: undefined,
			executeModule: undefined
		};
		for (const [name, hook] of Object.entries(hookMap)) {
			if (typeof hook !== "undefined" && hook.taps.length === 0) {
				disabledHooks.push(name);
			}
		}

		// disabledHooks is in order
		if (this.#disabledHooks.join() !== disabledHooks.join()) {
			this.#getInstance((error, instance) => {
				if (error) {
					return callback && callback(error);
				}
				instance?.unsafe_set_disabled_hooks(disabledHooks);
				this.#disabledHooks = disabledHooks;
			});
		}
	}

	async #beforeCompile() {
		await this.hooks.beforeCompile.promise();
		// compilation is not created yet, so this will fail
		// this.#updateDisabledHooks();
	}

	async #afterCompile() {
		await this.hooks.afterCompile.promise(this.compilation);
		this.#updateDisabledHooks();
	}

	async #finishMake() {
		await this.hooks.finishMake.promise(this.compilation);
		this.#updateDisabledHooks();
	}

	async #buildModule(module: binding.JsModule) {
		const normalized = normalizeJsModule(module);
		this.compilation.hooks.buildModule.call(normalized);
		this.#updateDisabledHooks();
	}

	async #processAssets(stage: number) {
		await this.compilation
			.__internal_getProcessAssetsHookByStage(stage)
			.promise(this.compilation.assets);
		this.#updateDisabledHooks();
	}

	async #beforeResolve(resolveData: binding.BeforeResolveData) {
		const normalizedResolveData = {
			request: resolveData.request,
			context: resolveData.context,
			fileDependencies: [],
			missingDependencies: [],
			contextDependencies: []
		};
		let ret =
			await this.compilation.normalModuleFactory?.hooks.beforeResolve.promise(
				normalizedResolveData
			);

		this.#updateDisabledHooks();
		resolveData.request = normalizedResolveData.request;
		resolveData.context = normalizedResolveData.context;
		return [ret, resolveData];
	}

	async #afterResolve(resolveData: binding.AfterResolveData) {
		let res =
			await this.compilation.normalModuleFactory?.hooks.afterResolve.promise(
				resolveData
			);

		NormalModule.getCompilationHooks(this.compilation).loader.tap(
			"sideEffectFreePropPlugin",
			(loaderContext: any) => {
				loaderContext._module = {
					factoryMeta: {
						sideEffectFree: !!resolveData.factoryMeta.sideEffectFree
					}
				};
			}
		);
		this.#updateDisabledHooks();
		return res;
	}

	async #contextModuleBeforeResolve(resourceData: binding.BeforeResolveData) {
		let res =
			await this.compilation.contextModuleFactory?.hooks.beforeResolve.promise(
				resourceData
			);

		this.#updateDisabledHooks();
		return res;
	}

	async #normalModuleFactoryResolveForScheme(
		input: binding.JsResolveForSchemeInput
	): Promise<binding.JsResolveForSchemeResult> {
		let stop =
			await this.compilation.normalModuleFactory?.hooks.resolveForScheme
				.for(input.scheme)
				.promise(input.resourceData);
		return {
			resourceData: input.resourceData,
			stop: stop === true
		};
	}

	async #optimizeChunkModules() {
		await this.compilation.hooks.optimizeChunkModules.promise(
			this.compilation.__internal__getChunks(),
			this.compilation.modules
		);
		this.#updateDisabledHooks();
	}

	async #optimizeTree() {
		await this.compilation.hooks.optimizeTree.promise(
			this.compilation.__internal__getChunks(),
			this.compilation.modules
		);
		this.#updateDisabledHooks();
	}

	async #optimizeModules() {
		await this.compilation.hooks.optimizeModules.promise(
			this.compilation.modules
		);
		this.#updateDisabledHooks();
	}

	#chunkAsset(assetArg: binding.JsChunkAssetArgs) {
		this.compilation.hooks.chunkAsset.call(assetArg.chunk, assetArg.filename);
		this.#updateDisabledHooks();
	}

	async #finishModules() {
		await this.compilation.hooks.finishModules.promise(
			this.compilation.modules
		);
		this.#updateDisabledHooks();
	}

	async #make() {
		await this.hooks.make.promise(this.compilation);
		this.#updateDisabledHooks();
	}
	async #shouldEmit(): Promise<boolean | undefined> {
		const res = this.hooks.shouldEmit.call(this.compilation);
		this.#updateDisabledHooks();
		return Promise.resolve(res);
	}
	async #emit() {
		await this.hooks.emit.promise(this.compilation);
		this.#updateDisabledHooks();
	}
	async #assetEmitted(args: binding.JsAssetEmittedArgs) {
		const filename = args.filename;
		const info = {
			compilation: this.compilation,
			outputPath: args.outputPath,
			targetPath: args.targetPath,
			get source() {
				return this.compilation.getAsset(args.filename)?.source;
			},
			get content() {
				return this.source?.buffer();
			}
		};
		await this.hooks.assetEmitted.promise(filename, info);
		this.#updateDisabledHooks();
	}

	async #afterEmit() {
		await this.hooks.afterEmit.promise(this.compilation);
		this.#updateDisabledHooks();
	}

	#succeedModule(module: binding.JsModule) {
		this.compilation.hooks.succeedModule.call(module);
		this.#updateDisabledHooks();
	}

	#stillValidModule(module: binding.JsModule) {
		this.compilation.hooks.stillValidModule.call(module);
		this.#updateDisabledHooks();
	}

	#executeModule({
		entry,
		runtimeModules,
		codegenResults
	}: {
		entry: string;
		runtimeModules: string[];
		codegenResults: binding.JsCodegenerationResults;
	}) {
		const __webpack_require__: any = (id: string) => {
			const cached = moduleCache[id];
			if (cached !== undefined) {
				if (cached.error) throw cached.error;
				return cached.exports;
			}

			var execOptions = {
				id,
				module: {
					id,
					exports: {},
					loaded: false,
					error: undefined
				},
				require: __webpack_require__
			};

			interceptModuleExecution.forEach((handler: (execOptions: any) => void) =>
				handler(execOptions)
			);

			const result = codegenResults.map[id]["build time"];
			const moduleObject = execOptions.module;

			if (id) moduleCache[id] = moduleObject;

			tryRunOrWebpackError(
				() =>
					this.compilation.hooks.executeModule.call(
						{ result: new CodeGenerationResult(result), moduleObject },
						{ __webpack_require__ }
					),
				"Compilation.hooks.executeModule"
			);
			moduleObject.loaded = true;
			return moduleObject.exports;
		};

		const moduleCache: Record<string, any> = (__webpack_require__[
			RuntimeGlobals.moduleCache.replace(`${RuntimeGlobals.require}.`, "")
		] = {});
		const interceptModuleExecution = (__webpack_require__[
			RuntimeGlobals.interceptModuleExecution.replace(
				`${RuntimeGlobals.require}.`,
				""
			)
		] = []);

		for (const runtimeModule of runtimeModules) {
			__webpack_require__(runtimeModule);
		}

		exports = __webpack_require__(entry);

		return JSON.stringify(exports);
	}

	#compilation(native: binding.JsCompilation) {
		// TODO: implement this based on the child compiler impl.
		this.hooks.compilation.call(this.compilation, {
			normalModuleFactory: this.compilation.normalModuleFactory!
		});

		this.#updateDisabledHooks();
	}

	#newCompilation(native: binding.JsCompilation) {
		const compilation = new Compilation(this, native);
		compilation.name = this.name;
		this.compilation = compilation;
		// reset normalModuleFactory when create new compilation
		let normalModuleFactory = new NormalModuleFactory();
		let contextModuleFactory = new ContextModuleFactory();
		this.compilation.normalModuleFactory = normalModuleFactory;
		this.hooks.normalModuleFactory.call(normalModuleFactory);
		this.compilation.contextModuleFactory = contextModuleFactory;
		this.hooks.contextModuleFactory.call(normalModuleFactory);
		this.hooks.thisCompilation.call(this.compilation, {
			normalModuleFactory: normalModuleFactory
		});
		this.#updateDisabledHooks();
	}

	run(callback: Callback<Error, Stats>) {
		if (this.running) {
			return callback(new ConcurrentCompilationError());
		}
		const startTime = Date.now();
		this.running = true;
		const doRun = () => {
			// @ts-expect-error
			const finalCallback = (err, stats?) => {
				this.idle = true;
				this.cache.beginIdle();
				this.idle = true;
				this.running = false;
				if (err) {
					this.hooks.failed.call(err);
				}
				if (callback) {
					callback(err, stats);
				}
				this.hooks.afterDone.call(stats);
			};
			this.hooks.beforeRun.callAsync(this, err => {
				if (err) {
					return finalCallback(err);
				}
				this.hooks.run.callAsync(this, err => {
					if (err) {
						return finalCallback(err);
					}

					this.build(err => {
						if (err) {
							return finalCallback(err);
						}
						this.compilation.startTime = startTime;
						this.compilation.endTime = Date.now();
						const stats = new Stats(this.compilation);
						this.hooks.done.callAsync(stats, err => {
							if (err) {
								return finalCallback(err);
							} else {
								return finalCallback(null, stats);
							}
						});
					});
				});
			});
		};

		if (this.idle) {
			this.cache.endIdle(err => {
				if (err) return callback(err);

				this.idle = false;
				doRun();
			});
		} else {
			doRun();
		}
	}
	// Safety: This method is only valid to call if the previous build task is finished, or there will be data races.
	build(callback: (error: Error | null) => void) {
		this.#getInstance((error, instance) => {
			if (error) {
				return callback && callback(error);
			}
			const unsafe_build = instance?.unsafe_build;
			const build_cb = unsafe_build?.bind(instance) as typeof unsafe_build;
			build_cb?.(error => {
				if (error) {
					callback(error);
				} else {
					callback(null);
				}
			});
		});
	}

	// Safety: This method is only valid to call if the previous rebuild task is finished, or there will be data races.
	rebuild(
		modifiedFiles?: ReadonlySet<string>,
		removedFiles?: ReadonlySet<string>,
		callback?: (error: Error | null) => void
	) {
		this.#getInstance((error, instance) => {
			if (error) {
				return callback && callback(error);
			}
			const unsafe_rebuild = instance?.unsafe_rebuild;
			const rebuild_cb = unsafe_rebuild?.bind(
				instance
			) as typeof unsafe_rebuild;
			rebuild_cb?.(
				[...(modifiedFiles ?? [])],
				[...(removedFiles ?? [])],
				error => {
					if (error) {
						callback && callback(error);
					} else {
						callback && callback(null);
					}
				}
			);
		});
	}

	compile(callback: Callback<Error, Compilation>) {
		const startTime = Date.now();
		this.hooks.beforeCompile.callAsync(void 0, (err: any) => {
			if (err) {
				return callback(err);
			}
			this.hooks.compile.call([]);

			this.build(err => {
				if (err) {
					return callback(err);
				}
				this.compilation.startTime = startTime;
				this.compilation.endTime = Date.now();
				this.hooks.afterCompile.callAsync(this.compilation, err => {
					if (err) {
						return callback(err);
					}
					return callback(null, this.compilation);
				});
			});
		});
	}

	watch(watchOptions: WatchOptions, handler: Callback<Error, Stats>): Watching {
		if (this.running) {
			// @ts-expect-error
			return handler(new ConcurrentCompilationError());
		}
		this.running = true;
		this.watchMode = true;
		// @ts-expect-error
		this.watching = new Watching(this, watchOptions, handler);
		return this.watching;
	}

	purgeInputFileSystem() {
		if (this.inputFileSystem && this.inputFileSystem.purge) {
			this.inputFileSystem.purge();
		}
	}

	close(callback: (error?: Error | null) => void) {
		// WARNING: Arbitrarily dropping the instance is not safe, as it may still be in use by the background thread.
		// A hint is necessary for the compiler to know when it is safe to drop the instance.
		// For example: register a callback to the background thread, and drop the instance when the callback is called (calling the `close` method queues the signal)
		// See: https://github.com/webpack/webpack/blob/4ba225225b1348c8776ca5b5fe53468519413bc0/lib/Compiler.js#L1218
		if (!this.running) {
			// Manually drop the instance.
			// this.#_instance = undefined;
		}

		if (this.watching) {
			// When there is still an active watching, close this first
			this.watching.close(() => {
				this.close(callback);
			});
			return;
		}
		this.hooks.shutdown.callAsync(err => {
			if (err) return callback(err);
			this.cache.shutdown(callback);
		});
	}

	getAsset(name: string) {
		let source = this.compilation.__internal__getAssetSource(name);
		if (!source) {
			return null;
		}
		return source.buffer();
	}

	__internal__registerBuiltinPlugin(plugin: binding.BuiltinPlugin) {
		this.builtinPlugins.push(plugin);
	}
}

export { Compiler };
