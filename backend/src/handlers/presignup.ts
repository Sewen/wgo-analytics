import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { allowlistMessage, emailAllowed } from '../lib/allowlist';

/** Cognito pre sign-up trigger: only email domains on the allowlist can create accounts. */
export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  // users an admin creates in the console are deliberate exceptions
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  if (!emailAllowed(event.request.userAttributes.email ?? '')) throw new Error(allowlistMessage());
  return event;
}
