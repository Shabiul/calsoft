import { redirect } from "next/navigation";

/** There is no sign-up form: signing in with Google (or a company Zoho account) creates the account. Old links land on the login. */
export default function SignupPage() {
  redirect("/login");
}
