import { deliver, type DeliveryRequest } from '../lib/triggers';

/** Invoked asynchronously by ingest with one trigger's matches; Lambda retries failed async invocations twice. */
export async function handler(req: DeliveryRequest): Promise<{ result: string }> {
  return { result: await deliver(req) };
}
