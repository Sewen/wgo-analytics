import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import { query } from '../lib/db';
import { SCHEMA_STATEMENTS } from '../lib/schema';

/** CloudFormation custom resource: applies the (idempotent) DSQL schema on create/update. */
export async function handler(event: CloudFormationCustomResourceEvent, context: Context): Promise<void> {
  let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
  let reason = '';
  try {
    if (event.RequestType !== 'Delete') {
      // Data outlives the stack: Delete deliberately never drops tables.
      for (const sql of SCHEMA_STATEMENTS) {
        console.log('applying:', sql.split('\n')[0]);
        await query(sql);
      }
    }
  } catch (err) {
    console.error(err);
    status = 'FAILED';
    reason = String((err as Error).message ?? err).slice(0, 500);
  }

  const body = JSON.stringify({
    Status: status,
    Reason: reason || `See CloudWatch log stream ${context.logStreamName}`,
    PhysicalResourceId: 'wgo-dsql-schema',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  await fetch(event.ResponseURL, { method: 'PUT', body, headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) } });
}
