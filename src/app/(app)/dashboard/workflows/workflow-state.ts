import { WORKFLOW_SAMPLES } from "@/lib/workflow-samples";

export interface StepState {
  action: "send_email" | "send_webhook";
  offsetMinutes: number;
  to: "invitee" | "host" | "both";
  subject: string; body: string; /** attach the calendar invite (.ics) to the email */ attachIcs: boolean;
  url: string; secret: string; secretEnc?: string; hasSecret?: boolean;
}
export interface WorkflowFormValue {
  id?: string; name: string; trigger: string; eventTypeIds: string[]; isActive: boolean; steps: StepState[];
}
/** A new step starts from the confirmation sample (message, timing and calendar-invite attachment), all editable. */
export const blankStep = (): StepState => {
  const c = WORKFLOW_SAMPLES[0]!;
  return { action: "send_email", offsetMinutes: c.offsetMinutes, to: c.to, subject: c.subject, body: c.body, attachIcs: c.attachIcs, url: "", secret: "" };
};
export const emptyWorkflow = (): WorkflowFormValue => ({ name: "", trigger: "booking_created", eventTypeIds: [], isActive: true, steps: [blankStep()] });

