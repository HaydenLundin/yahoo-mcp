import type {
  ClientRegistrationCallbackOptions,
  ClientRegistrationCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../types";

/**
 * Anyone on the internet can POST /register, and KV keeps what they send for 90 days, so the
 * metadata is capped well below the provider's own 1 MiB body limit (ARCHITECTURE.md section 9).
 */
export const REGISTRATION_LIMITS = {
  bodyBytes: 4096,
  nameChars: 100,
  redirectUris: 5,
  redirectUriChars: 512,
} as const;

export async function checkRegistration({
  clientMetadata,
  request,
}: ClientRegistrationCallbackOptions): Promise<ClientRegistrationCallbackResult | void> {
  const reject = (description: string): ClientRegistrationCallbackResult => ({
    code: "invalid_client_metadata",
    description,
    status: 400,
  });
  const body = await request.text();
  if (body.length > REGISTRATION_LIMITS.bodyBytes)
    return reject(
      `Registration body larger than ${REGISTRATION_LIMITS.bodyBytes} bytes`,
    );
  const name = clientMetadata.client_name;
  if (typeof name === "string" && name.length > REGISTRATION_LIMITS.nameChars)
    return reject(
      `client_name longer than ${REGISTRATION_LIMITS.nameChars} characters`,
    );
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0)
    return reject("redirect_uris is required");
  if (uris.length > REGISTRATION_LIMITS.redirectUris)
    return reject(
      `More than ${REGISTRATION_LIMITS.redirectUris} redirect_uris`,
    );
  if (
    uris.some(
      (u) =>
        typeof u !== "string" ||
        u.length > REGISTRATION_LIMITS.redirectUriChars,
    )
  )
    return reject(
      `A redirect_uri is longer than ${REGISTRATION_LIMITS.redirectUriChars} characters`,
    );
}

/** Once every client is onboarded the operator closes registration with REGISTRATION_ENABLED=false; no redeploy. */
export function registrationClosed(
  request: Request,
  env: Env,
): Response | null {
  if (env.REGISTRATION_ENABLED !== "false") return null;
  if (new URL(request.url).pathname !== "/register") return null;
  return Response.json(
    {
      error: "access_denied",
      error_description:
        "Client registration is closed on this server. Ask the operator to open it.",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
