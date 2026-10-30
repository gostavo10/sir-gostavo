import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter, Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "Match Chat — Game & Talk",
  description:
    "Create a room, invite your friends, play Combat Online 2 and chat in the same page. Messages stay while the room lives.",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Match Chat",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${playfair.variable} ${inter.variable} ${cairo.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster theme="dark" position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
