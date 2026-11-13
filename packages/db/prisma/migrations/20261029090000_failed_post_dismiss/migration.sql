-- Failed posts screen: a dismissed failure notice. The post is not touched.
ALTER TABLE "PostTarget" ADD COLUMN "failureDismissedAt" TIMESTAMP(3);
