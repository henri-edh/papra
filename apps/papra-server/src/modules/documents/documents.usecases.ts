import type { Database } from '../app/database/database.types';
import type { Config } from '../config/config.types';
import type { PlansRepository } from '../plans/plans.repository';
import type { Logger } from '../shared/logger/logger';
import type { SubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import type { TaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import type { TagsRepository } from '../tags/tags.repository';
import type { TrackingServices } from '../tracking/tracking.services';
import type { WebhookRepository } from '../webhooks/webhook.repository';
import type { DocumentActivityRepository } from './document-activity/document-activity.repository';
import type { DocumentsRepository } from './documents.repository';
import type { Document } from './documents.types';
import type { DocumentStorageService } from './storage/documents.storage.services';
import { safely } from '@corentinth/chisels';
import { extractTextFromFile } from '@papra/lecture';
import pLimit from 'p-limit';
import { checkIfOrganizationCanCreateNewDocument } from '../organizations/organizations.usecases';
import { createPlansRepository } from '../plans/plans.repository';
import { createLogger } from '../shared/logger/logger';
import { isDefined } from '../shared/utils';
import { createSubscriptionsRepository } from '../subscriptions/subscriptions.repository';
import { createTaggingRulesRepository } from '../tagging-rules/tagging-rules.repository';
import { applyTaggingRules } from '../tagging-rules/tagging-rules.usecases';
import { createTagsRepository } from '../tags/tags.repository';
import { createTrackingServices } from '../tracking/tracking.services';
import { createWebhookRepository } from '../webhooks/webhook.repository';
import { deferTriggerWebhooks } from '../webhooks/webhook.usecases';
import { createDocumentActivityRepository } from './document-activity/document-activity.repository';
import { deferRegisterDocumentActivityLog } from './document-activity/document-activity.usecases';
import { createDocumentAlreadyExistsError, createDocumentNotDeletedError, createDocumentNotFoundError } from './documents.errors';
import { buildOriginalDocumentKey, generateDocumentId as generateDocumentIdImpl } from './documents.models';
import { createDocumentsRepository } from './documents.repository';
import { getFileSha256Hash } from './documents.services';
import { createDocumentStorageService } from './storage/documents.storage.services';

const logger = createLogger({ namespace: 'documents:usecases' });

export async function extractDocumentText({ file, ocrLanguages }: { file: File; ocrLanguages?: string[] }) {
  const { textContent, error, extractorName } = await extractTextFromFile({ file, config: { tesseract: { languages: ocrLanguages } } });

  if (error) {
    logger.error({ error, extractorName }, 'Error while extracting text from document');
  }

  return {
    text: textContent ?? '',
  };
}

export async function createDocument({
  file,
  userId,
  organizationId,
  ocrLanguages = [],
  documentsRepository,
  documentsStorageService,
  generateDocumentId = generateDocumentIdImpl,
  plansRepository,
  subscriptionsRepository,
  trackingServices,
  taggingRulesRepository,
  tagsRepository,
  webhookRepository,
  documentActivityRepository,
  logger = createLogger({ namespace: 'documents:usecases' }),
}: {
  file: File;
  userId?: string;
  organizationId: string;
  ocrLanguages?: string[];
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  generateDocumentId?: () => string;
  plansRepository: PlansRepository;
  subscriptionsRepository: SubscriptionsRepository;
  trackingServices: TrackingServices;
  taggingRulesRepository: TaggingRulesRepository;
  tagsRepository: TagsRepository;
  webhookRepository: WebhookRepository;
  documentActivityRepository: DocumentActivityRepository;
  logger?: Logger;
}) {
  const {
    name: fileName,
    size,
    type: mimeType,
  } = file;

  await checkIfOrganizationCanCreateNewDocument({
    organizationId,
    newDocumentSize: size,
    documentsRepository,
    plansRepository,
    subscriptionsRepository,
  });

  const { hash } = await getFileSha256Hash({ file });

  // Early check to avoid saving the file and then realizing it already exists with the db constraint
  const { document: existingDocument } = await documentsRepository.getOrganizationDocumentBySha256Hash({ sha256Hash: hash, organizationId });

  const { document } = existingDocument
    ? await handleExistingDocument({
        existingDocument,
        fileName,
        organizationId,
        documentsRepository,
        tagsRepository,
        logger,
      })
    : await createNewDocument({
        file,
        fileName,
        size,
        mimeType,
        hash,
        userId,
        organizationId,
        documentsRepository,
        documentsStorageService,
        generateDocumentId,
        trackingServices,
        ocrLanguages,
        logger,
      });

  deferRegisterDocumentActivityLog({
    documentId: document.id,
    event: 'created',
    userId,
    documentActivityRepository,
  });

  await applyTaggingRules({ document, taggingRulesRepository, tagsRepository });

  deferTriggerWebhooks({
    webhookRepository,
    organizationId,
    event: 'document:created',
    payload: {
      documentId: document.id,
      organizationId,
      name: document.name,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    },
  });

  return { document };
}

export type CreateDocumentUsecase = Awaited<ReturnType<typeof createDocumentCreationUsecase>>;
export type DocumentUsecaseDependencies = Omit<Parameters<typeof createDocument>[0], 'file' | 'userId' | 'organizationId'>;

export async function createDocumentCreationUsecase({
  db,
  config,
  ...initialDeps
}: {
  db: Database;
  config: Config;
} & Partial<DocumentUsecaseDependencies>) {
  const deps = {
    documentsRepository: initialDeps.documentsRepository ?? createDocumentsRepository({ db }),
    documentsStorageService: initialDeps.documentsStorageService ?? await createDocumentStorageService({ config }),
    plansRepository: initialDeps.plansRepository ?? createPlansRepository({ config }),
    subscriptionsRepository: initialDeps.subscriptionsRepository ?? createSubscriptionsRepository({ db }),
    trackingServices: initialDeps.trackingServices ?? createTrackingServices({ config }),
    taggingRulesRepository: initialDeps.taggingRulesRepository ?? createTaggingRulesRepository({ db }),
    tagsRepository: initialDeps.tagsRepository ?? createTagsRepository({ db }),
    webhookRepository: initialDeps.webhookRepository ?? createWebhookRepository({ db }),
    documentActivityRepository: initialDeps.documentActivityRepository ?? createDocumentActivityRepository({ db }),

    ocrLanguages: initialDeps.ocrLanguages ?? config.documents.ocrLanguages,
    generateDocumentId: initialDeps.generateDocumentId,
    logger: initialDeps.logger,
  };

  return async (args: { file: File; userId?: string; organizationId: string }) => createDocument({ ...args, ...deps });
}

async function handleExistingDocument({
  existingDocument,
  fileName,
  userId,
  organizationId,
  documentsRepository,
  tagsRepository,
  logger,
}: {
  existingDocument: Document;
  fileName: string;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  tagsRepository: TagsRepository;
  logger: Logger;
}) {
  if (!existingDocument.isDeleted) {
    throw createDocumentAlreadyExistsError();
  }

  logger.info({ documentId: existingDocument.id }, 'Document already exists, restoring for deduplication');

  const [, { document: restoredDocument }] = await Promise.all([
    tagsRepository.removeAllTagsFromDocument({ documentId: existingDocument.id }),
    documentsRepository.restoreDocument({ documentId: existingDocument.id, organizationId, name: fileName, userId }),
  ]);

  return { document: restoredDocument };
}

async function createNewDocument({
  file,
  fileName,
  size,
  mimeType,
  hash,
  userId,
  organizationId,
  documentsRepository,
  documentsStorageService,
  generateDocumentId,
  trackingServices,
  ocrLanguages,
  logger,
}: {
  file: File;
  fileName: string;
  size: number;
  mimeType: string;
  hash: string;
  userId?: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  generateDocumentId: () => string;
  trackingServices: TrackingServices;
  ocrLanguages?: string[];
  logger: Logger;
}) {
  const documentId = generateDocumentId();

  const { originalDocumentStorageKey } = buildOriginalDocumentKey({
    documentId,
    organizationId,
    fileName,
  });

  const { storageKey } = await documentsStorageService.saveFile({
    file,
    storageKey: originalDocumentStorageKey,
  });

  const { text } = await extractDocumentText({ file, ocrLanguages });

  const [result, error] = await safely(documentsRepository.saveOrganizationDocument({
    id: documentId,
    name: fileName,
    organizationId,
    originalName: fileName,
    createdBy: userId,
    originalSize: size,
    originalStorageKey: storageKey,
    mimeType,
    content: text,
    originalSha256Hash: hash,
  }));

  if (error) {
    logger.error({ error }, 'Error while creating document');

    // If the document is not saved, delete the file from the storage
    await documentsStorageService.deleteFile({ storageKey: originalDocumentStorageKey });

    logger.error({ error }, 'Stored document file deleted because of error');

    throw error;
  }

  if (isDefined(userId)) {
    trackingServices.captureUserEvent({ userId, event: 'Document created' });
  }

  logger.info({ documentId, userId, organizationId }, 'Document created');

  return { document: result.document };
}

export async function getDocumentOrThrow({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  return { document };
}

export async function ensureDocumentExists({
  documentId,
  organizationId,
  documentsRepository,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
}) {
  await getDocumentOrThrow({ documentId, organizationId, documentsRepository });
}

export async function hardDeleteDocument({
  document,
  documentsRepository,
  documentsStorageService,
}: {
  document: Pick<Document, 'id' | 'originalStorageKey'>;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  // TODO: use transaction

  await Promise.all([
    documentsRepository.hardDeleteDocument({ documentId: document.id }),
    documentsStorageService.deleteFile({ storageKey: document.originalStorageKey }),
  ]);
}

export async function deleteExpiredDocuments({
  documentsRepository,
  documentsStorageService,
  config,
  now = new Date(),
  logger = createLogger({ namespace: 'documents:deleteExpiredDocuments' }),
}: {
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
  config: Config;
  now?: Date;
  logger?: Logger;
}) {
  const { documents } = await documentsRepository.getExpiredDeletedDocuments({
    expirationDelayInDays: config.documents.deletedDocumentsRetentionDays,
    now,
  });

  const limit = pLimit(10);

  await Promise.all(
    documents.map(async document => limit(async () => {
      const [, error] = await safely(hardDeleteDocument({ document, documentsRepository, documentsStorageService }));

      if (error) {
        logger.error({ document, error }, 'Error while deleting expired document');
      }
    })),
  );

  return {
    deletedDocumentsCount: documents.length,
  };
}

export async function deleteTrashDocument({
  documentId,
  organizationId,
  documentsRepository,
  documentsStorageService,
}: {
  documentId: string;
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  const { document } = await documentsRepository.getDocumentById({ documentId, organizationId });

  if (!document) {
    throw createDocumentNotFoundError();
  }

  if (!document.isDeleted) {
    throw createDocumentNotDeletedError();
  }

  await hardDeleteDocument({ document, documentsRepository, documentsStorageService });
}

export async function deleteAllTrashDocuments({
  organizationId,
  documentsRepository,
  documentsStorageService,
}: {
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: DocumentStorageService;
}) {
  const { documents } = await documentsRepository.getAllOrganizationTrashDocuments({ organizationId });

  // TODO: refactor to use batching and transaction

  const limit = pLimit(10);

  await Promise.all(
    documents.map(async document => limit(async () => hardDeleteDocument({ document, documentsRepository, documentsStorageService }))),
  );
}
