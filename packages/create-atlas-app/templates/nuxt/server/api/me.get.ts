// A protected server route. The global Atlas middleware already verified the session
// token locally; protect() answers 401 for an anonymous caller.
export default defineEventHandler(async (event) => {
  const auth = await getAtlasAuth(event);
  auth.protect();
  return { userId: auth.userId, orgId: auth.orgId };
});
