import { redirect } from "next/navigation";

/** There is no sign-up: employees get an account by signing in with their company Zoho account. Old links land on the login. */
export default function SignupPage() {
  redirect("/login");
}
