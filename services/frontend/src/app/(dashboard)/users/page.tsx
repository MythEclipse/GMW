import type { Metadata } from "next";
import { getUsers } from "@/lib/api/server";
import { UsersView } from "./view";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const users = await getUsers({ limit: 30 });
  return <UsersView initialUsers={users.data} />;
}
