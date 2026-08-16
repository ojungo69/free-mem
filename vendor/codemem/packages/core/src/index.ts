/**
 * @codemem/core — store, embeddings, and shared types.
 *
 * This package owns the SQLite store, embedding worker interface,
 * and type definitions shared across the codemem TS backend.
 */

export * as Api from "./api-types.js";
export { extractApplyPatchPaths, MUTATING_TOOL_NAMES } from "./apply-patch.js";
export * from "./attribution-assessment.js";
export * from "./attribution-diagnostics.js";
export type { ClaudeHookAdapterEvent, ClaudeHookRawEventEnvelope } from "./claude-hooks.js";
export {
	buildIngestPayloadFromHook,
	buildRawEventEnvelopeFromHook,
	MAPPABLE_CLAUDE_HOOK_EVENTS,
	mapClaudeHookPayload,
	normalizeProjectLabel,
	resolveHookProject,
	TRANSCRIPT_TAIL_MAX_BYTES,
} from "./claude-hooks.js";
export type { CodexHookAdapterEvent, CodexHookRawEventEnvelope } from "./codex-hooks.js";
export {
	buildIngestPayloadFromCodexHook,
	buildRawEventEnvelopeFromCodexHook,
	MAPPABLE_CODEX_HOOK_EVENTS,
	mapCodexHookPayload,
} from "./codex-hooks.js";
export type { DaemonHandle, DaemonHealth, DaemonIdentity } from "./daemon-lifecycle.js";
export {
	assertDataDirPreflight,
	forceKillDaemon,
	isForbiddenMountFstype,
	isNetworkFilesystemType,
	isWslWindowsSharePath,
	readDaemonHealth,
	readProcessIdentity,
	startDaemon,
	stopDaemon,
} from "./daemon-lifecycle.js";
export type {
	FileContextRetrievalAttempt,
	RpcMethod,
	RpcRequest,
	RpcSuccess,
	TypedRpcError,
} from "./daemon-rpc.js";
export {
	callDaemonRpc,
	dispatchDaemonRpc,
	HOOK_DELIVERY_BUDGETS,
	LOCAL_API_VERSION,
	mapPeerConnectError,
	NORMALIZED_SCHEMA_VERSION,
	RPC_CAPABILITY_HASH,
	RPC_DEFAULT_DEADLINE_MS,
	RPC_MAX_BYTES,
	RPC_METHODS,
	rpcDeadlineForMethod,
} from "./daemon-rpc.js";
export {
	assertSchemaReady,
	DEFAULT_DB_PATH,
	fromJson,
	fromJsonStrict,
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	MIN_COMPATIBLE_SCHEMA,
	resolveDbPath,
	SCHEMA_VERSION,
	tableExists,
	toJson,
	toJsonNullable,
} from "./db.js";
export {
	DEDUP_KEY_BACKFILL_JOB,
	hasPendingDedupKeyBackfill,
	runDedupKeyBackfillPass,
} from "./dedup-key-backfill.js";
export type {
	ArtifactKind,
	ContextFactFeature,
	DistillCandidate,
	DistillCandidateEmitOptions,
	DistillCluster,
	DistillClusterOptions,
	DistillContextChunk,
	DistillContextChunkOptions,
	DistillContextDedupeOptions,
	DistillContextDocument,
	DistillCorpusOptions,
	DistillDetector,
	DistillDocumentationMatch,
	DistillDocumentationSignal,
	DistillDocumentedCluster,
	DistillPromotabilityScores,
	DistillReport,
	DistillReportOptions,
	DistillScope,
	DistillScoredCluster,
	DistillScoringOptions,
	DistillVectorFeature,
} from "./distill.js";
export {
	buildDistillReport,
	chunkDistillContextDocuments,
	clusterDistillFeatures,
	createContextFactDetector,
	DEFAULT_CONTEXT_FACT_KINDS,
	embedDistillContextChunks,
	emitDistillCandidates,
	loadDistillVectorFeatures,
	markDistillClustersDocumented,
	projectContextFactFeatures,
	scoreDistillCluster,
	scoreDistillClusters,
	selectDistillCorpus,
} from "./distill.js";
export type {
	DistillApplyResult,
	DistillDraftPrompt,
	DistillDraftResult,
	DistillRuleDrafter,
} from "./distill-draft.js";
export {
	applyDistillRule,
	buildDistillDraftPrompt,
	DISTILL_BLOCK_BEGIN,
	DISTILL_BLOCK_END,
	DISTILL_LESSONS_HEADING,
	draftDistillRule,
	renderUnifiedDiff,
	sanitizeRuleLine,
} from "./distill-draft.js";
export type {
	DistillCandidateJudgement,
	DistillJudgePrompt,
	DistillJudgeVerdict,
	JudgedDistillCandidate,
} from "./distill-judge.js";
export {
	buildDistillJudgePrompt,
	judgeDistillCandidate,
	judgeDistillCandidates,
	judgeDistillReport,
	parseJudgeVerdict,
} from "./distill-judge.js";
export type { EmbeddingClient } from "./embeddings.js";
export {
	_resetEmbeddingClient,
	chunkText,
	embedTexts,
	getEmbeddingClient,
	hashText,
	serializeFloat32,
} from "./embeddings.js";
export type { InjectionEvalScenario, InjectionEvalScenarioPack } from "./eval-scenarios.js";
export {
	getInjectionEvalScenarioByPrompt,
	getInjectionEvalScenarioPack,
	getInjectionEvalScenarioPrompts,
	INJECTION_EVAL_SCENARIO_PACKS,
} from "./eval-scenarios.js";
export type { ExportOptions, ExportPayload, ImportOptions, ImportResult } from "./export-import.js";
export {
	buildImportKey,
	mergeSummaryMetadata,
	readImportPayload,
} from "./export-import.js";
export type {
	ExtractionBenchmarkQualityDimensions,
	ExtractionBenchmarkScore,
	ExtractionBenchmarkSummaryDispositionScore,
} from "./extraction-benchmark-scoring.js";
export {
	calculateCostAdjustedScore,
	calculateWeightedQualityCoverage,
	calculateWeightedQualityScore,
	scoreExtractionBenchmarkOutput,
} from "./extraction-benchmark-scoring.js";
export type {
	ExtractionBenchmarkBatch,
	ExtractionBenchmarkLabel,
	ExtractionBenchmarkLabelDisposition,
	ExtractionBenchmarkModelCandidate,
	ExtractionBenchmarkProfile,
	ExtractionBenchmarkReview,
} from "./extraction-benchmarks.js";
export {
	getExtractionBenchmarkProfile,
	listExtractionBenchmarkProfiles,
} from "./extraction-benchmarks.js";
export type {
	ExtractionStructuralDiagnostics,
	SessionExtractionEvalItem,
	SessionExtractionEvalResult,
	SessionExtractionEvalScenario,
	SessionExtractionEvalThread,
	SessionExtractionEvalThreadResult,
} from "./extraction-eval.js";
export {
	evaluateExtractionStructure,
	evaluateSessionExtractionItems,
	getSessionExtractionEval,
	getSessionExtractionEvalScenario,
} from "./extraction-eval.js";
export type {
	ExtractionModelCostEstimate,
	ExtractionModelPricing,
	NormalizedExtractionTokenUsage,
} from "./extraction-model-pricing.js";
export {
	estimateExtractionModelCost,
	getExtractionModelPricing,
	listExtractionModelPricing,
} from "./extraction-model-pricing.js";
export type { ExtractionReplayResult } from "./extraction-replay.js";
export {
	replayBatchExtraction,
	replayBatchExtractionWithTierRouting,
} from "./extraction-replay.js";
export type {
	ExtractionReplayTierRoutingDecision,
	ExtractionReplayTierRoutingInput,
} from "./extraction-tier-routing.js";
export {
	decideExtractionReplayTier,
	RICH_TIER_DEFAULTS,
	SIMPLE_TIER_DEFAULTS,
} from "./extraction-tier-routing.js";
export { buildFilterClauses, buildFilterClausesWithContext } from "./filters.js";
// Ingest pipeline
export {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	isInternalMemoryTool,
	LOW_SIGNAL_TOOLS,
	normalizeToolName,
	projectAdapterToolEvent,
} from "./ingest-events.js";
export { isLowSignalObservation, normalizeObservation } from "./ingest-filters.js";
export type { IngestOptions } from "./ingest-pipeline.js";
export { cleanOrphanSessions, ingest, main as ingestMain } from "./ingest-pipeline.js";
export { buildObserverPrompt } from "./ingest-prompts.js";
export {
	isSensitiveFieldName,
	sanitizePayload,
	sanitizeToolOutput,
	stripPrivate,
	stripPrivateObj,
} from "./ingest-sanitize.js";
export {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractAssistantUsage,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
	normalizeEventsForSessionContext,
	normalizeRequestText,
	TRIVIAL_REQUESTS,
} from "./ingest-transcript.js";
export type {
	IngestPayload,
	ObserverContext,
	ParsedObservation,
	ParsedOutput,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
export type { ObserverResponseStructuralDiagnostics } from "./ingest-xml-parser.js";
export {
	hasMeaningfulObservation,
	inspectObserverResponseStructure,
	parseObserverResponse,
	SUPPORTED_OBSERVATION_KINDS,
} from "./ingest-xml-parser.js";
export type { InstallManifest, ManagedBlock, ManagedTarget } from "./install-manifest.js";
export {
	applyManagedBlock,
	captureManagedTarget,
	installWithManifest,
	readInstallManifest,
	removeManagedBlock,
	uninstallWithManifest,
	writeInstallManifest,
} from "./install-manifest.js";
export { parsePositiveMemoryId, parseStrictInteger } from "./integers.js";
export type {
	BackfillTagsTextOptions,
	BackfillTagsTextResult,
	DeactivateLowSignalMemoriesOptions,
	DeactivateLowSignalResult,
	GateResult,
	MemoryArtifactClassCount,
	MemoryArtifactReport,
	MemoryArtifactReportOptions,
	MemoryRole,
	MemoryRoleReport,
	MemoryRoleReportComparison,
	MemoryRoleReportComparisonOptions,
	MemoryRoleReportOptions,
	RawEventRelinkAction,
	RawEventRelinkGroup,
	RawEventRelinkPlan,
	RawEventRelinkPlanOptions,
	RawEventRelinkReport,
	RawEventRelinkReportOptions,
	RawEventStatusItem,
	RawEventStatusResult,
	ReliabilityMetrics,
} from "./maintenance.js";
export {
	aiBackfillStructuredContent,
	backfillMemoryDedupKeys,
	backfillNarrativeFromBody,
	backfillTagsText,
	compareMemoryRoleReports,
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
	dedupNearDuplicateMemories,
	extractNarrativeFromBody,
	scanSecretsRetroactive,
} from "./maintenance.js";
export type {
	MaintenanceJobRecord,
	MaintenanceJobSnapshot,
	MaintenanceJobStatus,
	StartMaintenanceJobInput,
	UpdateMaintenanceJobInput,
} from "./maintenance-jobs.js";
export {
	completeMaintenanceJob,
	ensureMaintenanceJobsSchema,
	failMaintenanceJob,
	getMaintenanceJob,
	listMaintenanceJobs,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
export type {
	DerivedMemoryRole,
	DerivedMemoryRoleResult,
	InferMemoryRoleInput,
	MemoryArtifactClass,
	MemoryWorthinessAction,
	MemoryWorthinessReason,
	MemoryWorthinessResult,
} from "./memory-quality.js";
export {
	classifyMemoryWorthiness,
	inferMemoryRole,
	isDerivedFactRow,
	readArtifactClass,
} from "./memory-quality.js";
export type {
	MigrationBackupContext,
	MigrationBackupVerification,
	MigrationBackupVerifier,
	RunDatabaseMigrationsOptions,
} from "./migration-runner.js";
export { runDatabaseMigrations, verifyFreshDatabase } from "./migration-runner.js";
export type { MutationReceipt } from "./mutation-dispatcher.js";
export {
	dispatchClassA,
	ensureMutationReceiptSchema,
	hashMutationPayload,
	MutationConflictError,
} from "./mutation-dispatcher.js";
export * from "./normalized-event.js";
export type { ObserverAuthMaterial } from "./observer-auth.js";
export {
	ObserverAuthAdapter,
	probeAvailableCredentials,
	readAuthFile,
	redactText,
	renderObserverHeaders,
} from "./observer-auth.js";
export type {
	ObserverConfig,
	ObserverResponse,
	ObserverStatus,
	ObserverTokenUsage,
} from "./observer-client.js";
export { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
export type {
	ConfigPathResolution,
	ConfigPathSource,
	ConfigResolutionResult,
} from "./observer-config.js";
export {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	getCodememConfigPath,
	getCodememEnvOverrides,
	getOpenCodeProviderConfig,
	getProviderApiKey,
	getProviderBaseUrl,
	getProviderHeaders,
	getProviderOptions,
	getWorkspaceCodememConfigPath,
	getWorkspaceScopedCodememConfigPath,
	listConfiguredOpenCodeProviders,
	listCustomProviders,
	listObserverProviderOptions,
	loadOpenCodeConfig,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readWorkspaceCodememConfigFile,
	resolveBuiltInProviderDefaultModel,
	resolveBuiltInProviderFromModel,
	resolveBuiltInProviderModel,
	resolveCodememConfigPath,
	resolveCustomProviderDefaultModel,
	resolveCustomProviderFromModel,
	resolveCustomProviderModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
	writeWorkspaceCodememConfigFile,
} from "./observer-config.js";
export type {
	BackupCheck,
	BackupListEntry,
	BackupManifest,
	BackupRetentionClass,
	BackupSidecarV2,
	BackupVerification,
	RestoreBackupResult,
	VerifiedBackup,
} from "./online-backup.js";
export {
	backupPayloadHash,
	createCanonicalBackup,
	createDailyBackup,
	createOnlineBackup,
	listCanonicalBackups,
	pruneBackupRetention,
	requireVerifiedBackup,
	restoreCanonicalBackup,
	restorePayloadHash,
	runGatedMigration,
	verifyCanonicalBackup,
	verifyOnlineBackup,
} from "./online-backup.js";
export * from "./operational-status.js";
export * from "./outcome-evidence.js";
export type { PackArtifacts } from "./pack.js";
export {
	buildMemoryPack,
	buildMemoryPackAsync,
	buildMemoryPackTrace,
	buildMemoryPackTraceAsync,
	buildMemoryPackWithTrace,
	buildMemoryPackWithTraceAsync,
	estimateTokens,
} from "./pack.js";
export {
	projectBasename,
	projectClause,
	projectColumnClause,
	projectMatchesFilter,
	resolveProject,
	resolveProjectRoot,
} from "./project.js";
export * from "./prompt-pack-ledger.js";
export type { FlushRawEventsOptions } from "./raw-event-flush.js";
export { buildSessionContext, flushRawEvents } from "./raw-event-flush.js";
export { RawEventSweeper } from "./raw-event-sweeper.js";
export type { AgentMemoryConfig, RedactionResult } from "./redaction-pipeline.js";
export {
	applyDaemonIntake,
	parseAgentMemoryToml,
	preprocessAdapterEvent,
} from "./redaction-pipeline.js";
export { REDACTION_WORKER_DEADLINE_MS, warmRedactionWorker } from "./redaction-worker.js";
export {
	hasPendingRefBackfill,
	REF_BACKFILL_JOB,
	runRefBackfillPass,
} from "./ref-backfill.js";
export { clearMemoryRefs, normalizeConcept, populateMemoryRefs } from "./ref-populate.js";
export type { RefQueryOptions, RefQueryResult } from "./ref-queries.js";
export { findByConcept, findByFile } from "./ref-queries.js";
export * from "./retrieval-ledger.js";
export * from "./retrieval-surface-ledger.js";
export * as schema from "./schema.js";
export type {
	LegacyMemoryScopeClassification,
	LegacyMemoryScopeInput,
	ScopeBackfillOptions,
	ScopeBackfillReason,
	ScopeBackfillResult,
} from "./scope-backfill.js";
export {
	backfillScopeIds,
	classifyLegacyMemoryScope,
	ensureScopeBackfillScopes,
	hasPendingScopeBackfill,
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	runScopeBackfillPass,
	SCOPE_BACKFILL_JOB,
} from "./scope-backfill.js";
export type {
	CanonicalWorkspaceIdentity,
	ResolveProjectScopeInput,
	ScopeMapping,
	ScopeResolution,
	ScopeResolutionReason,
	WorkspaceIdentityInput,
	WorkspaceIdentitySource,
} from "./scope-resolution.js";
export {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
} from "./scope-resolution.js";
export type { StoreHandle } from "./search.js";
export {
	dedupeOrderedIds,
	expandQuery,
	explain,
	kindBonus,
	recencyScore,
	rerankResults,
	search,
	timeline,
} from "./search.js";
export {
	hasPendingSessionContextBackfill,
	runSessionContextBackfillPass,
	SESSION_CONTEXT_BACKFILL_JOB,
} from "./session-context-backfill.js";
export * from "./spool.js";
export type { StorageJournal, StorageJournalState, StorageLayout } from "./storage.js";
export {
	DEFAULT_DATA_DIR,
	ensureStorageLayout,
	readCurrentDatabasePointer,
	recoverStorageJournal,
	resolveRuntimeDataDir,
	resolveStorageLayout,
	runLegacyMigration,
	sha256File,
	writeStorageJournal,
} from "./storage.js";
export type { MemoryStore } from "./store.js";
export {
	hasPendingSummaryDedupBackfill,
	runSummaryDedupBackfillPass,
	SUMMARY_DEDUP_BACKFILL_JOB,
} from "./summary-dedup-backfill.js";
export { canonicalMemoryKind, getSummaryMetadata, isSummaryLikeMemory } from "./summary-memory.js";
export { deriveTags, fileTags, normalizeTag } from "./tags.js";
// Test utilities (exported for consumer packages like viewer-server)
export type { MixedScopeFixture } from "./test-utils.js";
export {
	initTestSchema,
	insertTestSession,
	seedMixedScopeFixture,
} from "./test-utils.js";
export {
	isOneOf,
	isSpaceOrPunctuation,
	isWhitespace,
	trimEndWhere,
	trimStartWhere,
	trimWhere,
} from "./text-trim.js";
export type {
	Artifact,
	ExplainError,
	ExplainItem,
	ExplainResponse,
	ExplainScoreComponents,
	MemoryFilters,
	MemoryItem,
	MemoryItemResponse,
	MemoryResult,
	OpenCodeSession,
	PackItem,
	PackRenderOptions,
	PackResponse,
	PackTrace,
	PackTraceCandidate,
	PackTraceCandidateScores,
	PackTraceDisposition,
	PackTraceMode,
	PackTraceSection,
	RawEvent,
	RawEventFlushBatch,
	RawEventIngestSample,
	RawEventIngestStats,
	RawEventSession,
	Session,
	SessionSummary,
	StoreStats,
	TimelineItemResponse,
	UsageEvent,
	UserPrompt,
} from "./types.js";
export { runVectorMigrationPass, VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";
export type {
	BackfillVectorsOptions,
	BackfillVectorsResult,
	SemanticIndexDiagnostics,
	SemanticSearchResult,
} from "./vectors.js";
export {
	backfillVectors,
	getSemanticIndexDiagnostics,
	semanticSearch,
	storeVectors,
} from "./vectors.js";
export { VERSION } from "./version.js";
export {
	readViewerBearerToken,
	VIEWER_NONCE_TTL_MS,
	VIEWER_SESSION_LIMIT,
	VIEWER_SESSION_TTL_MS,
	ViewerAuthState,
} from "./viewer-auth.js";
export type {
	ViewerLivenessProbeDependencies,
	ViewerLivenessProbeResult,
	ViewerTarget,
} from "./viewer-probe.js";
export {
	isLoopbackHost,
	probeCodememViewerLiveness,
	VIEWER_SERVICE_DISCRIMINATOR,
	viewerUrl,
} from "./viewer-probe.js";
export type { ReadOnlyActor, WriterActor } from "./writer-actor.js";
