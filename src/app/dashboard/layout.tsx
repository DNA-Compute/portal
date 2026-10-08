import localFont from "next/font/local";
import { SessionGuard } from "@/components/SessionGuard";

// Self-hosted so a build never depends on reaching Google Fonts. These are the
// variable latin files next/font/google downloaded, one file per family.
const ibmPlexSans = localFont({
  src: "./fonts/ibm-plex-sans-latin.woff2",
  weight: "100 700",
  variable: "--font-body",
});

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-latin.woff2",
  weight: "300 700",
  variable: "--font-display",
});

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`dashboard-layout ${ibmPlexSans.variable} ${spaceGrotesk.variable}`}>
      <SessionGuard redirectTo="/account" />
      {children}
    </div>
  );
}
