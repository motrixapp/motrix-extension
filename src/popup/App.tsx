import { Activity, AlertTriangle, ScanSearch } from 'lucide-react'
import { memo, type ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@/background/ConnectionManager'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { BackendSelector } from '@/popup/BackendSelector'
import {
  CompactPopupHeader,
  PopupBottomNavigation,
  type PopupTab,
} from '@/popup/CompactPopupLayout'
import { ConnectionPanel } from '@/popup/ConnectionPanel'
import { ControlPanel } from '@/popup/ControlPanel'
import { DashboardTile } from '@/popup/DashboardTile'
import { MediaPanel } from '@/popup/MediaPanel'
import { PairingPromptDialog } from '@/popup/PairingPromptDialog'
import { QuickSettingsPanel } from '@/popup/QuickSettingsPanel'
import { SpeedTile } from '@/popup/SpeedTile'
import { type TaskControlPanel, useControlPanel } from '@/popup/useControlPanel'
import {
  type PopupEndpoint,
  type PopupState,
  usePopupState,
} from '@/popup/usePopupState'
import {
  type QuickSettingsController,
  useQuickSettings,
} from '@/popup/useQuickSettings'
import { connectionErrorKey } from '@/shared/errorCopy'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'
import { CONSENT_VERSION } from '@/shared/takeover'

function CompactConnectionNotice({
  text,
}: {
  text: string
}): React.ReactElement {
  return (
    <div
      role="status"
      className="flex h-8 items-center gap-2 border-b border-amber-500/20 bg-amber-500/[0.07] px-3 text-[10px]/4"
    >
      <AlertTriangle
        className="size-3.5 shrink-0 text-amber-600"
        aria-hidden="true"
      />
      <span className="truncate">{text}</span>
    </div>
  )
}

const PopupHeaderSection = memo(function PopupHeaderSection({
  connection,
  endpoint,
  switching,
  takeoverChecked,
  takeoverDisabled,
  onEndpointChange,
  onTakeoverChange,
  onOpenSettings,
}: {
  connection: ConnectionState | null
  endpoint: PopupEndpoint | null
  switching: boolean
  takeoverChecked: boolean
  takeoverDisabled: boolean
  onEndpointChange: (endpointId: string) => void
  onTakeoverChange: (checked: boolean) => void
  onOpenSettings: () => void
}): React.ReactElement {
  return (
    <CompactPopupHeader
      backend={
        <BackendSelector
          connection={connection}
          endpoint={endpoint}
          busy={switching}
          onEndpointChange={onEndpointChange}
          onConfigureServer={onOpenSettings}
        />
      }
      takeoverChecked={takeoverChecked}
      takeoverDisabled={takeoverDisabled}
      onTakeoverChange={onTakeoverChange}
      onOpenSettings={onOpenSettings}
    />
  )
})

const PopupDashboard = memo(function PopupDashboard({
  uploadSpeed,
  downloadSpeed,
  activeTaskCount,
  resourceCount,
  onShowTasks,
  onShowResources,
}: {
  uploadSpeed: number
  downloadSpeed: number
  activeTaskCount: number
  resourceCount: number
  onShowTasks: () => void
  onShowResources: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <section
      data-testid="dashboard-tiles"
      aria-label={t('popup.dashboard.title')}
      className="mt-4 grid h-20 grid-cols-4 gap-4"
    >
      <SpeedTile
        kind="upload"
        label={t('popup.speed.upload')}
        bytesPerSecond={uploadSpeed}
      />
      <SpeedTile
        kind="download"
        label={t('popup.speed.download')}
        bytesPerSecond={downloadSpeed}
      />
      <DashboardTile
        testId="tile-activity"
        label={t('popup.dashboard.activity')}
        value={activeTaskCount}
        icon={Activity}
        iconClassName="text-connection-online"
        ariaLabel={t('popup.dashboard.showTasks')}
        onClick={onShowTasks}
      />
      <DashboardTile
        testId="tile-resources"
        label={t('popup.dashboard.resources')}
        value={resourceCount}
        icon={ScanSearch}
        iconClassName="text-speed-download"
        ariaLabel={t('popup.dashboard.showResources')}
        onClick={onShowResources}
      />
    </section>
  )
})

const PopupContent = memo(function PopupContent({
  tab,
  onTabChange,
  connected,
  state,
  statusState,
  taskController,
  notice,
  needsServer,
  onReconnect,
  onOpenOptions,
  onShowPairing,
  backendKey,
  onMediaCountChange,
  quickSettings,
}: {
  tab: PopupTab
  onTabChange: (tab: PopupTab) => void
  connected: boolean
  state: PopupState
  statusState: PopupState
  taskController: TaskControlPanel
  notice: ReactNode
  needsServer: boolean
  onReconnect: () => void
  onOpenOptions: () => void
  onShowPairing: () => void
  backendKey: string
  onMediaCountChange: (count: number) => void
  quickSettings: QuickSettingsController
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as PopupTab)}
      className="mt-4 h-[428px] min-h-0 gap-0"
    >
      <TabsContent value="tasks" className="h-[384px] min-h-0 shrink-0">
        {connected && !state.loading ? (
          <ControlPanel
            connection={state.connection}
            controller={taskController}
            canRevealTask={state.capabilities.taskReveal}
            onReconnect={onReconnect}
            notice={notice}
          />
        ) : (
          <ConnectionPanel
            title={t('popup.tasks.title')}
            state={statusState}
            onReconnect={needsServer ? onOpenOptions : onReconnect}
            {...(needsServer
              ? { actionLabel: t('popup.backend.configureServer') }
              : { onShowPairing })}
          />
        )}
      </TabsContent>
      <TabsContent
        value="sniffer"
        keepMounted
        className="h-[384px] min-h-0 shrink-0"
      >
        <MediaPanel
          active={tab === 'sniffer'}
          connected={connected && !state.loading}
          submissionKey={backendKey}
          onMediaCountChange={onMediaCountChange}
        />
      </TabsContent>
      <TabsContent value="settings" className="h-[384px] min-h-0 shrink-0">
        <QuickSettingsPanel
          controller={quickSettings}
          onOpenFullSettings={onOpenOptions}
          className="mt-0"
        />
      </TabsContent>
      <PopupBottomNavigation />
    </Tabs>
  )
})

export function App(): React.ReactElement {
  const { t } = useTranslation()
  const { state, switching, reconnect, switchEndpoint, submitPairingCode } =
    usePopupState()
  const quickSettings = useQuickSettings()
  const [tab, setTab] = useState<PopupTab>('tasks')
  const [resourceCount, setResourceCount] = useState(0)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [pairingCodeError, setPairingCodeError] = useState<string | null>(null)
  const [submittingCode, setSubmittingCode] = useState(false)
  const [dismissedPairingDeadlineMs, setDismissedPairingDeadlineMs] = useState<
    number | null
  >(null)
  const connected = state.connection === 'connected'
  const needsServer =
    !hasNativeMessagingSupport() &&
    (state.endpoint?.activeEndpointId ?? 'local') === 'local'
  const statusState = useMemo(
    () =>
      endpointError === null
        ? state
        : { ...state, lastError: endpointError, lastErrorReason: null },
    [endpointError, state]
  )
  const backendKey = state.endpoint?.activeEndpointId ?? 'unresolved'
  const controller = useControlPanel(connected, backendKey)
  const taskController = useMemo<TaskControlPanel>(
    () => ({
      tasks: controller.tasks,
      loading: controller.loading,
      error: controller.error,
      refresh: controller.refresh,
      pause: controller.pause,
      resume: controller.resume,
      reveal: controller.reveal,
      remove: controller.remove,
    }),
    [
      controller.error,
      controller.loading,
      controller.pause,
      controller.refresh,
      controller.remove,
      controller.resume,
      controller.reveal,
      controller.tasks,
    ]
  )
  const activeTaskCount =
    controller.stats === null
      ? controller.tasks.filter(
          (task) => task.status !== 'completed' && task.status !== 'error'
        ).length
      : controller.stats.activeTasks + controller.stats.waitingTasks

  const openOptions = useCallback((): void => {
    void browser.runtime.openOptionsPage()
  }, [])

  const changeEndpoint = useCallback(
    async (endpointId: string): Promise<void> => {
      setEndpointError(null)
      try {
        await switchEndpoint(endpointId)
      } catch (error) {
        setEndpointError((error as Error).message)
      }
    },
    [switchEndpoint]
  )

  const handleSubmitCode = useCallback(
    async (code: string): Promise<void> => {
      setPairingCodeError(null)
      setSubmittingCode(true)
      try {
        await submitPairingCode(code)
      } catch {
        // Bus errors are developer-facing English; people see locale copy.
        setPairingCodeError(t('errors.connection.generic'))
      } finally {
        setSubmittingCode(false)
      }
    },
    [submitPairingCode, t]
  )

  const handleTakeoverChange = useCallback(
    (checked: boolean): void => {
      if (
        checked &&
        quickSettings.takeover !== null &&
        quickSettings.takeover.consentAckVersion < CONSENT_VERSION
      ) {
        // Keep the real quick-settings consent surface mounted and visible.
        setTab('settings')
      }
      void quickSettings.requestTakeoverEnabled(checked)
    },
    [quickSettings.requestTakeoverEnabled, quickSettings.takeover]
  )

  const connectedNotice = useMemo(
    () =>
      state.degraded ? (
        <CompactConnectionNotice text={t('popup.pairing.degradedBody')} />
      ) : statusState.lastError !== null ? (
        <CompactConnectionNotice
          text={t(connectionErrorKey(statusState.lastErrorReason))}
        />
      ) : undefined,
    [state.degraded, statusState.lastError, statusState.lastErrorReason, t]
  )
  const reconnectPopup = useCallback(() => void reconnect(), [reconnect])
  const showPairing = useCallback(() => setDismissedPairingDeadlineMs(null), [])
  const showTasks = useCallback(() => setTab('tasks'), [])
  const showResources = useCallback(() => setTab('sniffer'), [])
  const changeTab = useCallback((nextTab: PopupTab) => setTab(nextTab), [])
  const pairingPrompt =
    tab === 'tasks' &&
    state.pairingCode !== null &&
    dismissedPairingDeadlineMs !== state.pairingCode.deadlineMs
      ? state.pairingCode
      : null

  return (
    <main
      data-testid="compact-popup"
      className="box-border h-[600px] w-[400px] overflow-hidden bg-background p-4 font-sans text-foreground"
    >
      <PopupHeaderSection
        connection={state.loading ? 'connecting' : state.connection}
        endpoint={state.endpoint}
        switching={switching}
        takeoverChecked={quickSettings.takeover?.enabled ?? false}
        takeoverDisabled={quickSettings.loading || quickSettings.saving}
        onEndpointChange={changeEndpoint}
        onTakeoverChange={handleTakeoverChange}
        onOpenSettings={openOptions}
      />

      <PopupDashboard
        uploadSpeed={controller.stats?.totalUploadSpeed ?? 0}
        downloadSpeed={controller.stats?.totalDownloadSpeed ?? 0}
        activeTaskCount={activeTaskCount}
        resourceCount={resourceCount}
        onShowTasks={showTasks}
        onShowResources={showResources}
      />

      <PopupContent
        tab={tab}
        onTabChange={changeTab}
        connected={connected}
        state={state}
        statusState={statusState}
        taskController={taskController}
        notice={connectedNotice}
        needsServer={needsServer}
        onReconnect={reconnectPopup}
        onOpenOptions={openOptions}
        onShowPairing={showPairing}
        backendKey={backendKey}
        onMediaCountChange={setResourceCount}
        quickSettings={quickSettings}
      />

      {pairingPrompt && (
        <PairingPromptDialog
          prompt={pairingPrompt}
          error={pairingCodeError}
          submitting={submittingCode}
          onSubmit={(code) => void handleSubmitCode(code)}
          onDismiss={() =>
            setDismissedPairingDeadlineMs(pairingPrompt.deadlineMs)
          }
        />
      )}
    </main>
  )
}
