'use strict';

class WebError extends Error {
  constructor (message, code) {
    super(message)
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name

    if(!Number.isInteger(code) || code < 400 || code > 599) {
      code = 400;
    };
    this.status = code;
  }
}

// Errors Express/body-parser raise when they refuse a request themselves, as opposed
// to a route failing. Deliberately narrow: only the two markers the framework leaves —
// an http-errors object from body-parser/raw-body (string `type`, expose=true, 4xx), and
// the router's undecodable URL parameter (a URIError stamped 400). A bare `status` on
// any other error is not treated as a client refusal.
export function isClientRefusal(error, status) {
  if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
  if (error instanceof URIError) return true;
  return typeof error?.type === 'string' && error.expose === true;
}

export default WebError;
