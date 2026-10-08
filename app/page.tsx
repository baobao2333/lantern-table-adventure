import { requireChatGPTUser } from "./chatgpt-auth";
import Home from "./table/home";

export const dynamic = "force-dynamic";
async function SignedInTable({returnTo}: {returnTo: string}) {
  await requireChatGPTUser(returnTo);
  return <Home/>;
}
export default async function Page({searchParams}: {searchParams: Promise<{adventure?: string}>}) {
  const {adventure} = await searchParams;
  const returnTo = adventure ? `/?adventure=${encodeURIComponent(adventure)}` : "/";
  return <SignedInTable returnTo={returnTo}/>;
}
