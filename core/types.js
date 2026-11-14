/**
 * Shared JSDoc typedefs (no runtime content).
 *
 * @typedef {{id:number, tgUserId:number|null, name:string, addedBy:number}} Player
 * isGuest <=> tgUserId === null
 * @typedef {{id:number, playerId:number, kind:'buyin'|'rebuy', createdBy:number,
 *   cancelled:boolean}} Entry
 * @typedef {{playerId:number, chips:number, enteredBy:number}} Stack
 * @typedef {{id:number, chatId:number, messageId:number|null,
 *   countMessageId:number|null, chipsPerBuyin:number, priceKop:number,
 *   status:'active'|'counting'|'settled'|'cancelled', createdBy:number,
 *   cancelledBy:number|null, players:Player[], entries:Entry[], stacks:Stack[]}} GameSnapshot
 * players are in join order (id ASC); entries are id ASC.
 * @typedef {{from:number, to:number, kop:number}} Transfer
 */
export {};
