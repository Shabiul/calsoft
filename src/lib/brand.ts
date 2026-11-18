/** Product name is configurable via APP_NAME (server) / NEXT_PUBLIC_APP_NAME (client). */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || "MeetFlow";
