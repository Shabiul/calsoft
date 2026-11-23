/** Masked join links: invitees get <APP_URL>/j/<code>, which redirects to the real meeting URL (Meet/Zoom/Teams). */
const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const joinLink = (joinCode: string) => `${appUrl()}/j/${joinCode}`;

/** The link to show invitees: masked when there is an online meeting URL, else the original value (null/address). */
export function maskedMeetingUrl(b: { joinCode: string; meetingUrl: string | null }): string | null {
  return b.meetingUrl && /^https?:\/\//i.test(b.meetingUrl) ? joinLink(b.joinCode) : b.meetingUrl;
}
