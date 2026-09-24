/**
 * THE storefront availability rule. A variant can be ordered now when its product is made to order,
 * the variant accepts backorders, or it has stock nobody has reserved. A product is available when
 * it is made to order or any of its active, non-deleted variants is.
 *
 * `IN_STOCK` in listing.repository is the SQL twin of this function (tests hold them equal). Every
 * storefront surface - card, swatch, PDP, option matrix, search document, listing filter, facet -
 * reads availability through one of the two; checkout's reservation under a row lock stays the
 * final word.
 */

export function unreservedUnits(variant: { stockQty: number; reservedQty: number }): number {
  return Math.max(variant.stockQty - variant.reservedQty, 0);
}

export function isVariantAvailable(
  variant: { stockQty: number; reservedQty: number; allowBackorder: boolean },
  product: { isMadeToOrder: boolean },
): boolean {
  return product.isMadeToOrder || variant.allowBackorder || unreservedUnits(variant) > 0;
}
