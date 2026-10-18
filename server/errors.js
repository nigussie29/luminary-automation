export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
