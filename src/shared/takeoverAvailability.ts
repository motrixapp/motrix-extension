import {
  type EndpointConfig,
  isLocalEndpointId,
} from '@/background/EndpointConfigStore'

/** Use the selected id, never a resolver's fallback for an unavailable Server. */
export function supportsAutomaticTakeover(
  config: Pick<EndpointConfig, 'activeEndpointId'> | null
): boolean {
  return config !== null && isLocalEndpointId(config.activeEndpointId)
}
