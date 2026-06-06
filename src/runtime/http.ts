export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    ...init
  });
}

export function methodNotAllowed(method: string, allowed: string[]): Response {
  return json(
    {
      error: "method_not_allowed",
      message: `Method ${method} is not allowed for this route.`,
      allowed
    },
    {
      status: 405,
      headers: {
        allow: allowed.join(", ")
      }
    }
  );
}

export function badRequest(message: string, details?: unknown): Response {
  return json(
    {
      error: "bad_request",
      message,
      details: details ?? null
    },
    { status: 400 }
  );
}

export function notFound(message: string): Response {
  return json(
    {
      error: "not_found",
      message
    },
    { status: 404 }
  );
}
