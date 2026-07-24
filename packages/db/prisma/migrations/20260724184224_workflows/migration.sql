-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourcePlatform" "Platform" NOT NULL,
    "destinations" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workflow_clientId_enabled_idx" ON "Workflow"("clientId", "enabled");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
