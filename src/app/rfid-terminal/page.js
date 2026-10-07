import { redirect } from "next/navigation";
import { RfidTerminal } from "./rfid-terminal";

/**
 * The RFID kiosk, rebuilt with shadcn/ui. src/proxy.js admits only an
 * Administrator or Super Admin here. /rfid-terminal?classic=1 still opens
 * the previous (legacy) kiosk, which talks to the same API.
 */
export default async function RfidTerminalPage({ searchParams }) {
  const params = await searchParams;
  if (params?.classic === "1") redirect("/legacy/rfid-terminal.html");
  return <RfidTerminal />;
}
