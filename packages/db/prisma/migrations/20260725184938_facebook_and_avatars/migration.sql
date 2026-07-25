-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'facebook';

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "displayName" TEXT;
