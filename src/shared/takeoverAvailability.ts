import {
  type EndpointConfig,
  isLocalEndpointId,
} from '@/background/EndpointConfigStore'
import { supportsDownloadTakeover } from '@/shared/platformCapabilities'

/** Use the selected id, never a resolver's fallback for an unavailable Server. */
export function supportsAutomaticTakeover(
  config: Pick<EndpointConfig, 'activeEndpointId'> | null
): boolean {
  return (
    supportsDownloadTakeover() &&
    config !== null &&
    isLocalEndpointId(config.activeEndpointId)
  )
}
