import { CircleAlertIcon } from 'lucide-react'
import type * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCAL_ENDPOINT_ID } from '@/background/EndpointConfigStore'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { BackendListSection } from '@/options/integration/BackendListSection'
import { BackendPairingSection } from '@/options/integration/BackendPairingSection'
import { PairingDialog } from '@/options/integration/PairingDialog'
import { RemoteServerCard } from '@/options/integration/RemoteServerCard'
import { ServerEditorDialog } from '@/options/integration/ServerEditorDialog'
import { useIntegrationSettings } from '@/options/integration/useIntegrationSettings'
import { SettingPanel } from '@/options/SettingPanel'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function IntegrationTab(): React.ReactElement {
  const { t } = useTranslation()
  const localBackendAvailable = hasNativeMessagingSupport()
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const {
    config,
    connectionState,
    serverIdentity,
    activeEndpointId,
    activeServer,
    isRemote,
    paired,
    pairingLoading,
    busy,
    remotePolicyBusy,
    remotePolicy,
    error,
    editorOpen,
    setEditorOpen,
    editingServer,
    serverToDelete,
    setServerToDelete,
    openAddServer,
    openEditServer,
    handleEndpointChange,
    handleReconnect,
    handleForget,
    replaceRemotePolicy,
    handleSaveServer,
    handleDeleteServer,
    refreshAfterPairing,
  } = useIntegrationSettings()
  const localBackendUnavailable =
    !localBackendAvailable && activeEndpointId === LOCAL_ENDPOINT_ID
  const selectedEndpointName =
    activeServer?.name ??
    t(
      localBackendAvailable
        ? 'options.endpoint.localName'
        : 'popup.backend.server'
    )

  return (
    <>
      <SettingPanel title={t('options.tabs.integration')}>
        {error !== null && (
          <Alert variant="destructive" className="gap-y-1">
            <CircleAlertIcon />
            <AlertTitle>{t('options.common.saveError')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <BackendListSection
          config={config}
          localBackendAvailable={localBackendAvailable}
          connectionState={connectionState}
          paired={paired}
          pairingLoading={pairingLoading}
          busy={busy}
          onAdd={openAddServer}
          onEdit={openEditServer}
          onDelete={setServerToDelete}
          onActivate={handleEndpointChange}
        />

        <Separator className="my-5" />

        <BackendPairingSection
          selectedEndpointName={selectedEndpointName}
          localBackendUnavailable={localBackendUnavailable}
          isRemote={isRemote}
          pairingLoading={pairingLoading}
          paired={paired}
          ready={config !== null}
          busy={busy}
          onPair={() => setPairDialogOpen(true)}
          onReconnect={handleReconnect}
          onForget={handleForget}
        >
          {isRemote && activeServer !== null && (
            <RemoteServerCard
              server={activeServer}
              serverIdentity={serverIdentity}
              connectionState={connectionState}
              paired={paired}
              policy={remotePolicy}
              busy={busy || remotePolicyBusy}
              onPolicyChange={replaceRemotePolicy}
            />
          )}
        </BackendPairingSection>
      </SettingPanel>

      <ServerEditorDialog
        open={editorOpen}
        server={editingServer}
        onOpenChange={setEditorOpen}
        onSave={handleSaveServer}
      />

      <PairingDialog
        open={pairDialogOpen}
        remote={isRemote}
        onOpenChange={setPairDialogOpen}
        onPaired={refreshAfterPairing}
      />

      <AlertDialog
        open={serverToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setServerToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('options.servers.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                serverToDelete?.id === activeEndpointId
                  ? localBackendAvailable
                    ? 'options.servers.deleteActiveDescription'
                    : 'options.servers.deleteActiveServerOnlyDescription'
                  : 'options.servers.deleteDescription',
                { name: serverToDelete?.name ?? '' }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('options.common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDeleteServer()}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {t('options.servers.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
