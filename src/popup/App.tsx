import { Activity, AlertTriangle, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { useControlPanel } from '@/popup/useControlPanel'
import { usePopupState } from '@/popup/usePopupState'
import { useQuickSettings } from '@/popup/useQuickSettings'
import { connectionErrorKey } from '@/shared/errorCopy'
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
  const statusState =
    endpointError === null
      ? state
      : { ...state, lastError: endpointError, lastErrorReason: null }
  const backendKey = state.endpoint?.activeEndpointId ?? 'unresolved'
  const controller = useControlPanel(connected, backendKey)
  const activeTaskCount =
    controller.stats === null
      ? controller.tasks.filter(
          (task) => task.status !== 'completed' && task.status !== 'error'
        ).length
      : controller.stats.activeTasks + controller.stats.waitingTasks

  const openOptions = (): void => {
    void browser.runtime.openOptionsPage()
  }

  const changeEndpoint = async (endpointId: string): Promise<void> => {
    setEndpointError(null)
    try {
      await switchEndpoint(endpointId)
    } catch (error) {
      setEndpointError((error as Error).message)
    }
  }

  const handleSubmitCode = async (code: string): Promise<void> => {
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
  }

  const handleTakeoverChange = (checked: boolean): void => {
    if (
      checked &&
      quickSettings.takeover !== null &&
      quickSettings.takeover.consentAckVersion < CONSENT_VERSION
    ) {
      // Keep the real quick-settings consent surface mounted and visible.
      setTab('settings')
    }
    void quickSettings.requestTakeoverEnabled(checked)
  }

  const connectedNotice = state.degraded ? (
    <CompactConnectionNotice text={t('popup.pairing.degradedBody')} />
  ) : statusState.lastError !== null ? (
    <CompactConnectionNotice
      text={t(connectionErrorKey(statusState.lastErrorReason))}
    />
  ) : undefined
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
      <CompactPopupHeader
        backend={
          <BackendSelector
            connection={state.loading ? 'connecting' : state.connection}
            endpoint={state.endpoint}
            busy={switching}
            onEndpointChange={(endpointId) => void changeEndpoint(endpointId)}
            onConfigureServer={openOptions}
          />
        }
        takeoverChecked={quickSettings.takeover?.enabled ?? false}
        takeoverDisabled={quickSettings.loading || quickSettings.saving}
        onTakeoverChange={handleTakeoverChange}
        onOpenSettings={openOptions}
      />

      <section
        data-testid="dashboard-tiles"
        aria-label={t('popup.dashboard.title')}
        className="mt-4 grid h-20 grid-cols-4 gap-4"
      >
        <SpeedTile
          kind="upload"
          label={t('popup.speed.upload')}
          bytesPerSecond={controller.stats?.totalUploadSpeed ?? 0}
        />
        <SpeedTile
          kind="download"
          label={t('popup.speed.download')}
          bytesPerSecond={controller.stats?.totalDownloadSpeed ?? 0}
        />
        <DashboardTile
          testId="tile-activity"
          label={t('popup.dashboard.activity')}
          value={activeTaskCount}
          icon={Activity}
          iconClassName="text-connection-online"
          ariaLabel={t('popup.dashboard.showTasks')}
          onClick={() => setTab('tasks')}
        />
        <DashboardTile
          testId="tile-resources"
          label={t('popup.dashboard.resources')}
          value={resourceCount}
          icon={ScanSearch}
          iconClassName="text-speed-download"
          ariaLabel={t('popup.dashboard.showResources')}
          onClick={() => setTab('sniffer')}
        />
      </section>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PopupTab)}
        className="mt-4 h-[428px] min-h-0 gap-0"
      >
        <TabsContent value="tasks" className="h-[384px] min-h-0 shrink-0">
          {connected && !state.loading ? (
            <ControlPanel
              connection={state.connection}
              controller={controller}
              canRevealTask={state.capabilities.taskReveal}
              onReconnect={() => void reconnect()}
              notice={connectedNotice}
            />
          ) : (
            <ConnectionPanel
              title={t('popup.tasks.title')}
              state={statusState}
              onReconnect={() => void reconnect()}
              onShowPairing={() => setDismissedPairingDeadlineMs(null)}
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
            onMediaCountChange={setResourceCount}
          />
        </TabsContent>
        <TabsContent value="settings" className="h-[384px] min-h-0 shrink-0">
          <QuickSettingsPanel
            controller={quickSettings}
            onOpenFullSettings={openOptions}
            className="mt-0"
          />
        </TabsContent>
        <PopupBottomNavigation />
      </Tabs>

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
