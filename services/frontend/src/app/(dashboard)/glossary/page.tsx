import type { Metadata } from "next";
import {
  getChannelCultures,
  getFlaggedDomains,
  getGlossary,
} from "@/lib/api/server";
import { GlossaryView } from "./view";

export const metadata: Metadata = { title: "Glossary" };

const DAYS = 30;

export default async function GlossaryPage() {
  const [cultures, glossary, domains] = await Promise.all([
    getChannelCultures({ limit: 50 }),
    getGlossary({ limit: 50 }),
    getFlaggedDomains(DAYS),
  ]);

  return (
    <GlossaryView
      initialCultures={cultures}
      initialGlossary={glossary}
      initialDomains={domains}
    />
  );
}
