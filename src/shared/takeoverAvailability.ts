import {
  type EndpointConfig,
  LOCAL_ENDPOINT_ID,
} from '@/background/EndpointConfigStore'

/** Use the selected id, never a resolver's fallback for an unavailable Server. */
export function supportsAutomaticTakeover(
  config: Pick<EndpointConfig, 'activeEndpointId'> | null
): boolean {
  return config?.activeEndpointId === LOCAL_ENDPOINT_ID
}
