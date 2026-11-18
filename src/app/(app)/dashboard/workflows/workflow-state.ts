export interface StepState {
  action: "send_email" | "send_webhook";
  offsetMinutes: number;
  to: "invitee" | "host" | "both";
  subject: string; body: string; url: string; secret: string; secretEnc?: string; hasSecret?: boolean;
}
export interface WorkflowFormValue {
  id?: string; name: string; trigger: string; eventTypeIds: string[]; isActive: boolean; steps: StepState[];
}
export const blankStep = (): StepState => ({
  action: "send_email", offsetMinutes: 0, to: "invitee",
  subject: "Thanks for booking, {{invitee_name}}", body: "Hi {{invitee_name}},\n\nLooking forward to {{event_title}} on {{start_time}}.\n\n{{host_name}}", url: "", secret: "",
});
export const emptyWorkflow = (): WorkflowFormValue => ({ name: "", trigger: "booking_created", eventTypeIds: [], isActive: true, steps: [blankStep()] });

