-- CreateEnum
CREATE TYPE "TagType" AS ENUM ('TOPIC', 'FORMAT');

-- AlterEnum
ALTER TYPE "ChatKnowledgeSourceType" ADD VALUE 'COMMUNITY';

-- AlterTable
ALTER TABLE "camps" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "consultation_services" ADD COLUMN     "audience" TEXT[],
ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "formatTagId" TEXT,
ADD COLUMN     "whatsIncluded" TEXT[];

-- AlterTable
ALTER TABLE "programs" ADD COLUMN     "audience" TEXT[];

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "TagType" NOT NULL DEFAULT 'TOPIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_tags" (
    "programId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "program_tags_pkey" PRIMARY KEY ("programId","tagId")
);

-- CreateTable
CREATE TABLE "consultation_service_tags" (
    "serviceId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "consultation_service_tags_pkey" PRIMARY KEY ("serviceId","tagId")
);

-- CreateTable
CREATE TABLE "community_tags" (
    "communityId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "community_tags_pkey" PRIMARY KEY ("communityId","tagId")
);

-- CreateTable
CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "gains" TEXT[],
    "iconKey" TEXT,
    "whatsappLink" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_join_requests" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "reason" TEXT,
    "agreedToPolicy" BOOLEAN NOT NULL DEFAULT false,
    "linkEmailedAt" TIMESTAMP(3),
    "emailError" TEXT,
    "source" TEXT NOT NULL DEFAULT 'community_page',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tags_type_name_idx" ON "tags"("type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_type_slug_key" ON "tags"("type", "slug");

-- CreateIndex
CREATE INDEX "program_tags_tagId_idx" ON "program_tags"("tagId");

-- CreateIndex
CREATE INDEX "consultation_service_tags_tagId_idx" ON "consultation_service_tags"("tagId");

-- CreateIndex
CREATE INDEX "community_tags_tagId_idx" ON "community_tags"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");

-- CreateIndex
CREATE INDEX "communities_isPublished_order_idx" ON "communities"("isPublished", "order");

-- CreateIndex
CREATE INDEX "community_join_requests_communityId_createdAt_idx" ON "community_join_requests"("communityId", "createdAt");

-- CreateIndex
CREATE INDEX "community_join_requests_email_idx" ON "community_join_requests"("email");

-- CreateIndex
CREATE UNIQUE INDEX "community_join_requests_communityId_email_key" ON "community_join_requests"("communityId", "email");

-- CreateIndex
CREATE INDEX "consultation_services_formatTagId_idx" ON "consultation_services"("formatTagId");

-- AddForeignKey
ALTER TABLE "consultation_services" ADD CONSTRAINT "consultation_services_formatTagId_fkey" FOREIGN KEY ("formatTagId") REFERENCES "tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_tags" ADD CONSTRAINT "program_tags_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_tags" ADD CONSTRAINT "program_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_service_tags" ADD CONSTRAINT "consultation_service_tags_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "consultation_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_service_tags" ADD CONSTRAINT "consultation_service_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_tags" ADD CONSTRAINT "community_tags_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_tags" ADD CONSTRAINT "community_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
