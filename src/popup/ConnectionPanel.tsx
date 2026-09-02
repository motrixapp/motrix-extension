import { useTranslation } from 'react-i18next'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import { ConnectionStatusPanel } from '@/popup/ConnectionStatusPanel'
import type { PopupState } from '@/popup/usePopupState'

export function ConnectionPanel({
  title,
  state,
  onReconnect,
  onShowPairing,
  actionLabel,
}: {
  title: string
  state: PopupState
  onReconnect: () => void
  onShowPairing?: () => void
  actionLabel?: string
}): React.ReactElement {
  const { t } = useTranslation()

  return (
    <section aria-label={title}>
      <CompactSectionToolbar title={title || t('popup.tasks.title')} />
      <CompactContentCard>
        <ConnectionStatusPanel
          state={state}
          onReconnect={onReconnect}
          {...(onShowPairing ? { onShowPairing } : {})}
          {...(actionLabel ? { actionLabel } : {})}
        />
      </CompactContentCard>
    </section>
  )
}
