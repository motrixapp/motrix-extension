import {
  CircleAlertIcon,
  KeyRoundIcon,
  LaptopIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type {
  ConnectionState,
  PairCandidate,
  ServerIdentity,
} from '@/background/ConnectionManager'
import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
  type MotrixServerEndpoint,
} from '@/background/EndpointConfigStore'
import { send } from '@/background/MessageBus'
import type {
  RemoteBackendPolicyReplacement,
  RemoteBackendPolicyV1,
} from '@/background/RemoteBackendPolicyStore'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SettingSection } from '@/options/components/SettingSection'
import { SettingPanel } from '@/options/SettingPanel'
import { type ServerFormValues, serverFormSchema } from '@/options/tabs/schemas'
import { zodFormResolver } from '@/options/zodFormResolver'
import { InstancePicker } from '@/popup/InstancePicker'
import { PairingCodePanel } from '@/popup/PairingCodePanel'
import { normalizeRemoteEndpoint } from '@/shared/endpoint'
import { connectionErrorKey } from '@/shared/errorCopy'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

function assertMessageSucceeded(value: unknown): void {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  ) {
    throw new Error(value.error)
  }
}

function ServerSecurityTooltip({ secure }: { secure: boolean }) {
  const { t } = useTranslation()
  const description = t(
    secure
      ? 'options.servers.statusTransportSecure'
      : 'options.servers.statusTransportPlain'
  )

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={description}
        className={cn(
          'inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4',
          secure ? 'text-muted-foreground' : 'text-destructive'
        )}
      >
        {secure ? (
          <ShieldCheckIcon aria-hidden="true" />
        ) : (
          <CircleAlertIcon aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <p>{description}</p>
      </TooltipContent>
    </Tooltip>
  )
}

interface ServerEditorDialogProps {
  open: boolean
  server: MotrixServerEndpoint | null
  onOpenChange: (open: boolean) => void
  onSave: (values: ServerFormValues) => Promise<void>
}

function ServerEditorDialog({
  open,
  server,
  onOpenChange,
  onSave,
}: ServerEditorDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const form = useForm<ServerFormValues>({
    resolver: zodFormResolver(serverFormSchema),
    defaultValues: { name: '', url: '' },
  })
  const configuredUrl = form.watch('url')
  const usesPlainWebSocket = configuredUrl.toLowerCase().startsWith('ws://')

  useEffect(() => {
    if (!open) return
    form.reset({
      name: server?.name ?? '',
      url: server?.url ?? '',
    })
  }, [form, open, server])

  const handleSubmit = async (values: ServerFormValues): Promise<void> => {
    try {
      await onSave(values)
      onOpenChange(false)
    } catch {
      // The parent surfaces the actionable error at the top of the panel.
      // Keeping the dialog open preserves the user's input so they can
      // correct and retry.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {server === null
              ? t('options.servers.addTitle')
              : t('options.servers.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('options.servers.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          id="motrix-server-form"
          onSubmit={form.handleSubmit(handleSubmit)}
        >
          <FieldGroup>
            <Field data-invalid={form.formState.errors.name !== undefined}>
              <FieldLabel htmlFor="motrix-server-name">
                {t('options.servers.nameLabel')}
              </FieldLabel>
              <Input
                id="motrix-server-name"
                autoComplete="off"
                placeholder={t('options.servers.namePlaceholder')}
                aria-invalid={form.formState.errors.name !== undefined}
                {...form.register('name')}
              />
              <FieldError>
                {form.formState.errors.name?.message === undefined
                  ? null
                  : t(form.formState.errors.name.message)}
              </FieldError>
            </Field>
            <Field data-invalid={form.formState.errors.url !== undefined}>
              <FieldLabel htmlFor="motrix-server-url">
                {t('options.servers.urlLabel')}
              </FieldLabel>
              <Input
                id="motrix-server-url"
                autoComplete="url"
                inputMode="url"
                placeholder={t('options.servers.urlPlaceholder')}
                aria-invalid={form.formState.errors.url !== undefined}
                {...form.register('url')}
              />
              <FieldDescription>
                {t('options.servers.urlDescription')}
              </FieldDescription>
              <FieldError>
                {form.formState.errors.url?.message === undefined
                  ? null
                  : t(form.formState.errors.url.message)}
              </FieldError>
            </Field>
            {usesPlainWebSocket && (
              <Alert aria-label={t('options.servers.transportWarningTitle')}>
                <CircleAlertIcon />
                <AlertTitle>
                  {t('options.servers.transportWarningTitle')}
                </AlertTitle>
                <AlertDescription>
                  {t('options.servers.transportWarningBody')}
                </AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('options.common.cancel')}
          </DialogClose>
          <Button
            type="submit"
            form="motrix-server-form"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && (
              <Spinner data-icon="inline-start" />
            )}
            {t('options.servers.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface PairingCodeState {
  run: number
  maxRuns: number
  attemptsRemaining: number | null
}

interface PairingDialogProps {
  open: boolean
  remote: boolean
  onOpenChange: (open: boolean) => void
  onPaired: () => void
}

/**
 * Discover → (auto-proceed on one candidate, or let the user choose) →
 * chooseCandidate → poll for the pairingCode prompt bg.getState surfaces →
 * submitPairingCode, repeating for each retry run until success or failure.
 *
 * Never renders "paired"/"connected" before `onPaired()` fires, and
 * `onPaired()` only fires once bg.getState reports `state === 'connected'`
 * — which is only true after a verified `confirmB`, never merely on
 * `pairAccept`.
 */
function PairingDialog({
  open,
  remote,
  onOpenChange,
  onPaired,
}: PairingDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [candidates, setCandidates] = useState<PairCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [chosen, setChosen] = useState(false)
  const [pairingCode, setPairingCode] = useState<PairingCodeState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const remoteAttemptStarted = useRef(false)

  const rescan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setDialogError(null)
    try {
      const response = await send('bg.listPairCandidates', undefined)
      assertMessageSucceeded(response)
      setCandidates(response.candidates)
    } catch {
      setDialogError(t('errors.connection.generic'))
    } finally {
      setScanning(false)
    }
  }, [t])

  useEffect(() => {
    if (!open) {
      remoteAttemptStarted.current = false
      setCandidates(null)
      setChosen(false)
      setPairingCode(null)
      setDialogError(null)
      return
    }
    if (remote) {
      if (remoteAttemptStarted.current) return
      remoteAttemptStarted.current = true
      setChosen(true)
      void send('bg.reconnect', undefined).then((response) => {
        try {
          assertMessageSucceeded(response)
        } catch {
          setDialogError(t('errors.connection.generic'))
        }
      })
      return
    }
    void rescan()
  }, [open, remote, rescan, t])

  const choose = useCallback(
    async (port: number): Promise<void> => {
      setChosen(true)
      setDialogError(null)
      try {
        const response = await send('bg.chooseCandidate', { port })
        assertMessageSucceeded(response)
        if (!response.ok) {
          setDialogError(t('errors.connection.generic'))
        }
      } catch {
        setDialogError(t('errors.connection.generic'))
      }
    },
    [t]
  )

  // A picker with exactly one row to click is friction, not a choice.
  useEffect(() => {
    if (!open || chosen || candidates === null || candidates.length !== 1) {
      return
    }
    const only = candidates[0]
    if (only !== undefined) void choose(only.port)
  }, [open, chosen, candidates, choose])

  // Poll for the pairingCode prompt (or completion/failure) once a
  // candidate has been chosen and the attempt is under way.
  useEffect(() => {
    if (!chosen) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const response = await send('bg.getState', undefined)
        assertMessageSucceeded(response)
        if (cancelled) return
        if (response.state === 'connected') {
          onPaired()
          onOpenChange(false)
          return
        }
        if (response.pairingCode) {
          // A live prompt and a failure banner are mutually exclusive: any
          // error still on display belongs to a superseded attempt.
          setDialogError(null)
        } else if (response.state === 'disconnected' && response.lastError) {
          // Locale copy keyed by the stable reason code — the raw
          // `lastError` sentence is developer-facing (same rule as the
          // popup's ConnectionStatusPanel).
          setDialogError(
            t(connectionErrorKey(response.lastErrorReason ?? null))
          )
        }
        setPairingCode(response.pairingCode ?? null)
      } catch {
        // Transient message-channel hiccups aren't worth surfacing on every
        // tick; the next successful poll clears whatever this one missed.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [chosen, onOpenChange, onPaired, t])

  // The MV3 heartbeat exists for exactly this window — while the popup (or,
  // here, this dialog) is showing the code-entry prompt — and must stop the
  // moment it isn't: a heartbeat that outlives its reason keeps the worker
  // alive for nothing. The response body is irrelevant; only the inbound
  // message matters.
  useEffect(() => {
    if (pairingCode === null) return
    const timer = setInterval(() => {
      void send('bg.pairHeartbeat', undefined)
    }, 20_000)
    return () => clearInterval(timer)
  }, [pairingCode])

  const submitCode = useCallback(
    async (code: string): Promise<void> => {
      setSubmitting(true)
      setDialogError(null)
      try {
        const response = await send('bg.submitPairingCode', { code })
        // ok:false is a business outcome (the pending prompt is gone —
        // expired or superseded), not a bus failure; check it BEFORE
        // assertMessageSucceeded, whose error-field duck test would
        // otherwise throw on the very same envelope and misfile it.
        if ((response as { ok?: boolean }).ok === false) {
          setDialogError(t('errors.connection.deadlineExceeded'))
          return
        }
        assertMessageSucceeded(response)
      } catch {
        setDialogError(t('errors.connection.generic'))
      } finally {
        setSubmitting(false)
      }
    },
    [t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('options.pairing.pairDialogTitle')}</DialogTitle>
        </DialogHeader>
        {dialogError !== null && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        )}
        {!remote && !chosen && (
          <InstancePicker
            candidates={candidates ?? []}
            onChoose={(port) => void choose(port)}
            onRescan={() => void rescan()}
            disabled={scanning}
            rescanning={scanning}
          />
        )}
        {chosen && pairingCode === null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t('options.pairing.loading')}
          </div>
        )}
        {chosen && pairingCode !== null && (
          <PairingCodePanel
            onSubmit={(code) => void submitCode(code)}
            size="lg"
            run={pairingCode.run}
            maxRuns={pairingCode.maxRuns}
            attemptsRemaining={pairingCode.attemptsRemaining}
            disabled={submitting}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function IntegrationTab(): React.ReactElement {
  const { t } = useTranslation()
  const localBackendAvailable = hasNativeMessagingSupport()
  const [config, setConfig] = useState<EndpointConfig | null>(null)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected')
  const [serverIdentity, setServerIdentity] = useState<ServerIdentity | null>(
    null
  )
  const [pairing, setPairing] = useState<{
    endpointId: string
    paired: boolean
  } | null>(null)
  const [pairingLoading, setPairingLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [remotePolicyBusy, setRemotePolicyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingServer, setEditingServer] =
    useState<MotrixServerEndpoint | null>(null)
  const [serverToDelete, setServerToDelete] =
    useState<MotrixServerEndpoint | null>(null)
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const [remotePolicy, setRemotePolicy] =
    useState<RemoteBackendPolicyV1 | null>(null)
  const remoteDownloadSwitchId = useId()

  const refreshConnection = useCallback(async (): Promise<void> => {
    const response = await send('bg.getState', undefined)
    assertMessageSucceeded(response)
    setConnectionState(response.state)
    setServerIdentity(response.server ?? null)
  }, [])

  const refreshPairing = useCallback(
    async (endpointId: string): Promise<void> => {
      setPairingLoading(true)
      try {
        const response = await send('bg.getPairingStatus', { endpointId })
        assertMessageSucceeded(response)
        setPairing({ endpointId, paired: response.paired })
      } finally {
        setPairingLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [endpointConfig, stateResponse] = await Promise.all([
          send('bg.getEndpointConfig', undefined),
          send('bg.getState', undefined),
        ])
        if (cancelled) return
        assertMessageSucceeded(endpointConfig)
        assertMessageSucceeded(stateResponse)
        setConfig(endpointConfig)
        setConnectionState(stateResponse.state)
        setServerIdentity(stateResponse.server ?? null)
        const pairingResponse = await send('bg.getPairingStatus', {
          endpointId: endpointConfig.activeEndpointId,
        })
        if (cancelled) return
        assertMessageSucceeded(pairingResponse)
        setPairing({
          endpointId: endpointConfig.activeEndpointId,
          paired: pairingResponse.paired,
        })
        setPairingLoading(false)
      } catch (cause) {
        if (!cancelled) {
          setError((cause as Error).message)
          setPairingLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const activeEndpointId = config?.activeEndpointId ?? LOCAL_ENDPOINT_ID
  const activeEndpointIdRef = useRef(activeEndpointId)
  activeEndpointIdRef.current = activeEndpointId
  const activeServer =
    config?.servers.find((server) => server.id === activeEndpointId) ?? null
  const localBackendUnavailable =
    !localBackendAvailable && activeEndpointId === LOCAL_ENDPOINT_ID
  const selectedEndpointName =
    activeServer?.name ??
    t(
      localBackendAvailable
        ? 'options.endpoint.localName'
        : 'popup.backend.server'
    )
  const paired =
    pairing?.endpointId === activeEndpointId ? pairing.paired : false
  const isRemote = activeEndpointId !== LOCAL_ENDPOINT_ID
  const backendRows: Array<{
    id: string
    name: string
    description: string
    server: MotrixServerEndpoint | null
  }> = [
    ...(localBackendAvailable
      ? [
          {
            id: LOCAL_ENDPOINT_ID,
            name: t('options.endpoint.localName'),
            description: t('options.endpoint.localDescription'),
            server: null,
          },
        ]
      : []),
    ...(config?.servers ?? []).map((server) => ({
      id: server.id,
      name: server.name,
      description: server.url,
      server,
    })),
  ]

  useEffect(() => {
    if (
      connectionState === 'connected' ||
      connectionState === 'disconnected' ||
      connectionState === 'denied'
    ) {
      return
    }

    let cancelled = false
    let inFlight = false
    const syncingEndpointId = activeEndpointId
    const syncConnection = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const response = await send('bg.getState', undefined)
        assertMessageSucceeded(response)
        if (cancelled || activeEndpointIdRef.current !== syncingEndpointId) {
          return
        }
        setConnectionState(response.state)
        setServerIdentity(response.server ?? null)
      } catch {
        // A transitional state can briefly outlive the background page. The
        // next tick retries until the connection reaches a terminal state.
      } finally {
        inFlight = false
      }
    }

    void syncConnection()
    const timer = window.setInterval(() => void syncConnection(), 1_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeEndpointId, connectionState])

  useEffect(() => {
    let cancelled = false
    if (!isRemote || !paired) {
      setRemotePolicy(null)
      return () => {
        cancelled = true
      }
    }
    if (connectionState !== 'connected') {
      return () => {
        cancelled = true
      }
    }
    void send('bg.getRemoteBackendPolicy', undefined)
      .then((response) => {
        if (cancelled) return
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
      })
      .catch(() => {
        if (!cancelled) setRemotePolicy(null)
      })
    return () => {
      cancelled = true
    }
  }, [connectionState, isRemote, paired])

  const runAction = async (
    action: () => Promise<void>,
    rethrow = false,
    setPending: React.Dispatch<React.SetStateAction<boolean>> = setBusy
  ): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError((cause as Error).message)
      try {
        const latest = await send('bg.getEndpointConfig', undefined)
        assertMessageSucceeded(latest)
        setConfig(latest)
        setPairing(null)
        await Promise.all([
          refreshPairing(latest.activeEndpointId),
          refreshConnection(),
        ])
      } catch {
        // Preserve the original operation error. A subsequent user action or
        // page reload will retry the catalogue read if this refresh also fails.
      }
      if (rethrow) throw cause
    } finally {
      setPending(false)
    }
  }

  const handleEndpointChange = async (endpointId: string): Promise<void> => {
    if (config === null || endpointId === config.activeEndpointId) return
    await runAction(async () => {
      const activated = await send('bg.activateEndpoint', { endpointId })
      assertMessageSucceeded(activated)
      setConfig(activated.config)
      setPairing(null)
      setRemotePolicy(null)
      setConnectionState('bootstrapping')
      setServerIdentity(null)
      await Promise.all([
        refreshPairing(activated.config.activeEndpointId),
        refreshConnection(),
      ])
    })
  }

  const handleReconnect = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.reconnect', undefined)
      assertMessageSucceeded(response)
      await Promise.all([refreshPairing(activeEndpointId), refreshConnection()])
    })
  }

  const handleForget = async (): Promise<void> => {
    await runAction(async () => {
      const response = await send('bg.unpair', {
        endpointId: activeEndpointId,
      })
      assertMessageSucceeded(response)
      await Promise.all([refreshPairing(activeEndpointId), refreshConnection()])
    })
  }

  const replaceRemotePolicy = async (
    replacement: RemoteBackendPolicyReplacement
  ): Promise<void> => {
    await runAction(
      async () => {
        const response = await send(
          'bg.replaceRemoteBackendPolicy',
          replacement
        )
        assertMessageSucceeded(response)
        setRemotePolicy(response.policy)
        // replaceRemoteBackendPolicy acknowledges only after its one
        // renegotiation attempt reaches a terminal state. Read that state
        // instead of leaving the page on a synthetic `bootstrapping` snapshot.
        await refreshConnection()
      },
      false,
      setRemotePolicyBusy
    )
  }

  const remotePolicyReplacement = (
    changes: Partial<RemoteBackendPolicyReplacement>
  ): RemoteBackendPolicyReplacement => ({
    remoteDataBoundaryAcceptedAt:
      remotePolicy?.remoteDataBoundaryAcceptedAt ?? null,
    allowRequestCredentials: remotePolicy?.allowRequestCredentials ?? false,
    allowCustomHeaders: remotePolicy?.allowCustomHeaders ?? false,
    allowPageContent: false,
    allowServerUrlProbe: false,
    allowServerUrlResolve: false,
    allowAutomaticTakeover: false,
    ...changes,
  })

  const openAddServer = (): void => {
    setEditingServer(null)
    setEditorOpen(true)
  }

  const openEditServer = (server: MotrixServerEndpoint): void => {
    setEditingServer(server)
    setEditorOpen(true)
  }

  const handleSaveServer = async (values: ServerFormValues): Promise<void> => {
    if (config === null) return
    await runAction(async () => {
      const normalizedUrl = normalizeRemoteEndpoint(values.url)
      const duplicate = config.servers.some(
        (server) =>
          server.id !== editingServer?.id && server.url === normalizedUrl
      )
      if (duplicate) throw new Error(t('options.servers.urlDuplicate'))

      const name = values.name.trim()
      const result =
        editingServer === null
          ? await send('bg.addServer', { name, url: normalizedUrl })
          : await send('bg.updateServer', {
              endpointId: editingServer.id,
              expected: {
                name: editingServer.name,
                url: editingServer.url,
                revision: editingServer.revision,
              },
              changes: { name, url: normalizedUrl },
            })
      assertMessageSucceeded(result)
      setConfig(result.config)
      setPairing(null)
      await Promise.all([
        refreshPairing(result.config.activeEndpointId),
        refreshConnection(),
      ])
    }, true)
  }

  const handleDeleteServer = async (): Promise<void> => {
    if (config === null || serverToDelete === null) return
    const deleting = serverToDelete
    await runAction(async () => {
      const removed = await send('bg.removeServer', {
        endpointId: deleting.id,
        expected: {
          name: deleting.name,
          url: deleting.url,
          revision: deleting.revision,
        },
      })
      assertMessageSucceeded(removed)
      setConfig(removed.config)
      setServerToDelete(null)
      if (removed.wasActive) {
        setPairing(null)
        setConnectionState('disconnected')
        await Promise.all([
          refreshPairing(removed.config.activeEndpointId),
          refreshConnection(),
        ])
      }
    })
  }

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

        <SettingSection
          title={t('options.endpoint.currentTitle')}
          description={t('options.endpoint.currentDescription')}
          action={
            <Button
              type="button"
              size="sm"
              disabled={config === null || busy}
              onClick={openAddServer}
            >
              <PlusIcon data-icon="inline-start" />
              {t('options.servers.add')}
            </Button>
          }
        >
          <ItemGroup aria-label={t('options.endpoint.listLabel')}>
            {backendRows.map((backend) => {
              const current = backend.id === activeEndpointId
              const server = backend.server
              return (
                <Item
                  key={backend.id}
                  role="listitem"
                  variant={current ? 'muted' : 'outline'}
                  size="sm"
                  aria-current={current ? 'true' : undefined}
                >
                  <ItemMedia variant="icon">
                    {backend.server === null ? <LaptopIcon /> : <ServerIcon />}
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{backend.name}</ItemTitle>
                    <ItemDescription title={backend.description}>
                      {backend.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="ml-auto max-w-full flex-wrap justify-end">
                    {current ? (
                      <>
                        <Badge variant="secondary">
                          {t('options.servers.current')}
                        </Badge>
                        <Badge
                          variant={
                            connectionState === 'connected'
                              ? 'default'
                              : 'outline'
                          }
                        >
                          {t(`options.endpoint.connection.${connectionState}`)}
                        </Badge>
                        <Badge variant={paired ? 'secondary' : 'outline'}>
                          {pairingLoading
                            ? t('options.pairing.loading')
                            : paired
                              ? t('options.pairing.paired')
                              : t('options.pairing.notPaired')}
                        </Badge>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={config === null || busy}
                        aria-label={t('options.endpoint.activateAria', {
                          name: backend.name,
                        })}
                        onClick={() => void handleEndpointChange(backend.id)}
                      >
                        {t('options.endpoint.activate')}
                      </Button>
                    )}
                    {server !== null && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={busy}
                          aria-label={t('options.servers.editAria', {
                            name: server.name,
                          })}
                          onClick={() => openEditServer(server)}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={busy}
                          aria-label={t('options.servers.deleteAria', {
                            name: server.name,
                          })}
                          onClick={() => setServerToDelete(server)}
                        >
                          <Trash2Icon />
                        </Button>
                      </>
                    )}
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>

          {config !== null && config.servers.length === 0 && (
            <Alert className="gap-y-1">
              <ServerIcon />
              <AlertTitle>{t('options.servers.emptyTitle')}</AlertTitle>
              <AlertDescription>
                {t('options.servers.emptyDescription')}
              </AlertDescription>
            </Alert>
          )}
        </SettingSection>

        <Separator className="my-5" />

        <SettingSection
          title={t('options.pairing.backendTitle', {
            name: selectedEndpointName,
          })}
          description={t('options.pairing.scopedHelp')}
        >
          {localBackendUnavailable ? (
            <Alert className="gap-y-1">
              <ServerIcon />
              <AlertTitle>
                {t('options.pairing.serverRequiredTitle')}
              </AlertTitle>
              <AlertDescription>
                {t('options.pairing.serverRequiredHelp')}
              </AlertDescription>
            </Alert>
          ) : pairingLoading ? (
            <Alert className="gap-y-1">
              <Spinner />
              <AlertTitle>{t('options.pairing.loading')}</AlertTitle>
              <AlertDescription>
                {t('options.pairing.scopedHelp')}
              </AlertDescription>
            </Alert>
          ) : isRemote ? (
            <Alert className="gap-y-1">
              {paired ? <ShieldCheckIcon /> : <KeyRoundIcon />}
              <AlertTitle>
                {paired
                  ? t('options.pairing.pairedTitle')
                  : t('options.pairing.remoteTitle')}
              </AlertTitle>
              <AlertDescription>
                {paired
                  ? t('options.pairing.pairedHelp')
                  : t('options.pairing.remoteHelp')}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="gap-y-1">
              {paired ? <ShieldCheckIcon /> : <KeyRoundIcon />}
              <AlertTitle>
                {paired
                  ? t('options.pairing.pairedTitle')
                  : t('options.pairing.localTitle')}
              </AlertTitle>
              <AlertDescription>
                {paired
                  ? t('options.pairing.pairedHelp')
                  : t('options.pairing.localHelp')}
              </AlertDescription>
            </Alert>
          )}
          {isRemote && activeServer !== null && (
            <Alert
              aria-label={t('options.servers.statusTitle')}
              className="gap-y-1 pr-4 has-data-[slot=alert-action]:pr-4"
            >
              <ServerIcon />
              <AlertTitle className={cn('truncate', paired && 'pr-40')}>
                {activeServer.name}
              </AlertTitle>
              {paired && (
                <AlertAction className="top-4 flex items-center gap-2">
                  <Label
                    htmlFor={remoteDownloadSwitchId}
                    className="whitespace-nowrap"
                  >
                    {t('options.pairing.remoteConsentTitle')}
                  </Label>
                  <Switch
                    id={remoteDownloadSwitchId}
                    aria-label={t('options.pairing.remoteConsentTitle')}
                    checked={remotePolicy?.remoteDataBoundaryAcceptedAt != null}
                    disabled={
                      connectionState !== 'connected' ||
                      remotePolicy === null ||
                      busy ||
                      remotePolicyBusy
                    }
                    onCheckedChange={(checked) =>
                      void replaceRemotePolicy(
                        remotePolicyReplacement({
                          remoteDataBoundaryAcceptedAt: checked
                            ? Date.now()
                            : null,
                          ...(!checked
                            ? {
                                allowCustomHeaders: false,
                                allowRequestCredentials: false,
                              }
                            : {}),
                        })
                      )
                    }
                  />
                </AlertAction>
              )}
              <AlertDescription className="flex flex-col gap-2 [&_p:not(:last-child)]:mb-0">
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 break-all">
                    {t('options.servers.statusAuthority', {
                      value: activeServer.url,
                    })}
                  </p>
                  <ServerSecurityTooltip
                    secure={activeServer.url.startsWith('wss://')}
                  />
                </div>
                {serverIdentity !== null && (
                  <p className="opacity-70">
                    {t('options.servers.statusRuntime', {
                      runtime: serverIdentity.runtime,
                      name: serverIdentity.name,
                      version: serverIdentity.version,
                    })}
                  </p>
                )}
                {paired && <p>{t('options.pairing.remoteConsentBody')}</p>}
                {paired && connectionState !== 'connected' && (
                  <p>{t('options.pairing.remoteConsentOffline')}</p>
                )}
                {remotePolicy?.remoteDataBoundaryAcceptedAt != null && (
                  <div className="flex flex-col gap-3 pt-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <p className="font-medium text-card-foreground">
                          {t('options.pairing.remoteHeadersLabel')}
                        </p>
                        <p>{t('options.pairing.remoteHeadersHelp')}</p>
                      </div>
                      <Switch
                        aria-label={t('options.pairing.remoteHeadersLabel')}
                        checked={remotePolicy.allowCustomHeaders}
                        disabled={
                          connectionState !== 'connected' ||
                          busy ||
                          remotePolicyBusy
                        }
                        onCheckedChange={(checked) =>
                          void replaceRemotePolicy(
                            remotePolicyReplacement({
                              allowCustomHeaders: checked,
                              ...(!checked
                                ? { allowRequestCredentials: false }
                                : {}),
                            })
                          )
                        }
                      />
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <p className="font-medium text-card-foreground">
                          {t('options.pairing.remoteCredentialsLabel')}
                        </p>
                        <p>{t('options.pairing.remoteCredentialsHelp')}</p>
                      </div>
                      <Switch
                        aria-label={t('options.pairing.remoteCredentialsLabel')}
                        checked={remotePolicy.allowRequestCredentials}
                        disabled={
                          connectionState !== 'connected' ||
                          busy ||
                          remotePolicyBusy ||
                          !remotePolicy.allowCustomHeaders
                        }
                        onCheckedChange={(checked) =>
                          void replaceRemotePolicy(
                            remotePolicyReplacement({
                              allowRequestCredentials: checked,
                            })
                          )
                        }
                      />
                    </div>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
          {!localBackendUnavailable && (
            <div className="flex flex-wrap gap-2">
              {!paired && (
                <Button
                  type="button"
                  disabled={config === null || busy}
                  onClick={() => setPairDialogOpen(true)}
                >
                  <KeyRoundIcon data-icon="inline-start" />
                  {t('options.pairing.pair')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={config === null || busy || !paired}
                onClick={() => void handleReconnect()}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {!busy && <RefreshCwIcon data-icon="inline-start" />}
                {t('options.pairing.reconnect')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!paired || busy}
                onClick={() => void handleForget()}
              >
                <Trash2Icon data-icon="inline-start" />
                {t('options.pairing.forget')}
              </Button>
            </div>
          )}
        </SettingSection>
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
        onPaired={() => {
          void Promise.all([
            refreshPairing(activeEndpointId),
            refreshConnection(),
          ])
        }}
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
