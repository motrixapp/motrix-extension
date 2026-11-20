import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Button } from '@/components/ui/button'
import { previewCloudDriveImport } from '@/options/cloudDriveImport'

export function CloudDriveImport({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const plan = open ? previewCloudDriveImport(value) : null
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setOpen(true)}
      >
        {t('options.takeover.importDomains')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-h-[90dvh] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('options.takeover.importDomains')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('options.takeover.importHint')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {plan && (
            <div className="min-h-0 overflow-y-auto text-sm">
              {(
                [
                  ['options.takeover.importNew', plan.added],
                  ['options.takeover.importCovered', plan.covered],
                ] as const
              ).map(([label, domains]) => (
                <section key={label} className="mb-3">
                  <h3 className="font-medium">
                    {t(label)} ({domains.length})
                  </h3>
                  <ul className="mt-1 text-muted-foreground">
                    {domains.map((domain) => (
                      <li dir="ltr" key={domain}>
                        {domain}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">
              {t('options.takeover.consentCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={!plan?.added.length}
              onClick={() => {
                if (plan?.added.length) onChange(plan.merged)
                setOpen(false)
              }}
            >
              {t('options.takeover.confirmImport')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
