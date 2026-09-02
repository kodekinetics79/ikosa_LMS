import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "iK Assure", template: "%s · iK Assure" }, description: "Operational skills assurance and continuous training needs analysis." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
