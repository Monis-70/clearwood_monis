import { Router } from 'express';

import { adminRouter } from './admin.routes';
import { adminCatalogRouter } from './adminCatalog.routes';
import { adminCartRouter, cartRouter } from './cart.routes';
import { catalogRouter } from './catalog.routes';
import { adminCmsRouter, contentRouter } from './cms.routes';
import { adminContentRouter, publicContentRouter } from './content.routes';
import { customerAuthRouter } from './customerAuth.routes';
import { adminDocumentRouter, documentRouter } from './document.routes';
import { adminFaqRouter, faqRouter } from './faq.routes';
import { adminFulfilmentRouter, fulfilmentRouter } from './fulfilment.routes';
import { adminMediaRouter, publicMediaRouter } from './media.routes';
import { adminNotificationRouter } from './notification.routes';
import { adminOrderRouter, checkoutRouter } from './order.routes';
import { adminPricingRouter, pricingRouter } from './pricing.routes';
import { adminReportRouter } from './report.routes';
import { settingRouter } from './setting.routes';
import { adminStorefrontRouter, storefrontRouter } from './storefront.routes';
import { versionRouter } from './version.routes';

export { healthRouter } from './health.routes';
/** Mounted OUTSIDE the JSON parser by app.ts: the signature is computed over the raw bytes. */
export { webhookRouter } from './order.routes';

/** R6 — everything business-facing is mounted under /api/v1 by app.ts. */
export const apiRouter: Router = Router();

apiRouter.use(versionRouter);
apiRouter.use(settingRouter);
apiRouter.use(catalogRouter);
apiRouter.use(publicMediaRouter);
apiRouter.use(pricingRouter);
apiRouter.use(storefrontRouter);
apiRouter.use(cartRouter);
apiRouter.use(checkoutRouter);
apiRouter.use(fulfilmentRouter);
apiRouter.use(documentRouter);
apiRouter.use(contentRouter);
apiRouter.use(faqRouter);
apiRouter.use(publicContentRouter);
apiRouter.use(customerAuthRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/admin', adminMediaRouter);
apiRouter.use('/admin', adminCatalogRouter);
apiRouter.use('/admin', adminPricingRouter);
apiRouter.use('/admin', adminStorefrontRouter);
apiRouter.use('/admin', adminCartRouter);
apiRouter.use('/admin', adminOrderRouter);
apiRouter.use('/admin', adminFulfilmentRouter);
apiRouter.use('/admin', adminDocumentRouter);
apiRouter.use('/admin', adminNotificationRouter);
apiRouter.use('/admin', adminReportRouter);
apiRouter.use('/admin', adminCmsRouter);
apiRouter.use('/admin', adminFaqRouter);
apiRouter.use('/admin', adminContentRouter);
