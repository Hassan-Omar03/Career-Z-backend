const router = require('express').Router();
const ctrl = require('../controllers/institutionFee.controller');
const { protect } = require('../middleware/auth');

// Receipt verification is intentionally public (QR code scanned by anyone, e.g. a scholarship
// sponsor or auditor) — never exposes platform commission/internal gateway data (see controller).
router.get('/receipts/verify/:code', ctrl.verifyReceipt);

router.use(protect);

router.get('/me/restriction', ctrl.getMyRestriction);

router.patch('/fees/:feeId/discount', ctrl.addDiscount);
router.post('/fees/:feeId/report-payment', ctrl.reportManualPayment);
router.patch('/fees/:feeId/verify-payment', ctrl.verifyManualPayment);
router.patch('/fees/:feeId/waive', ctrl.waiveFee);
router.patch('/fees/:feeId/cancel', ctrl.cancelInvoice);
router.patch('/fees/:feeId/payment-arrangement', ctrl.setPaymentArrangement);

router.patch('/:institutionId/programs/:programId/billing', ctrl.updateProgramBilling);
router.get('/:institutionId/schedules', ctrl.listSchedules);
router.get('/:institutionId/schedules/:scheduleId/preview', ctrl.previewGeneration);
router.post('/:institutionId/schedules/:scheduleId/generate', ctrl.generateForSchedule);
router.post('/:institutionId/generate-all', ctrl.generateForAllEligible);
router.get('/:institutionId/payments-awaiting-verification', ctrl.listAwaitingVerification);
router.get('/:institutionId/defaulters', ctrl.listDefaulters);
router.get('/:institutionId/invoices', ctrl.listInvoicesFiltered);
router.get('/:institutionId/reports/overview', ctrl.getOverview);
router.get('/:institutionId/reports/aging', ctrl.getAgingReport);
router.get('/:institutionId/reports/ledger', ctrl.getStudentLedger);
router.get('/:institutionId/reports/class-wise', ctrl.getClassWiseReport);
router.get('/:institutionId/reports/program-wise', ctrl.getProgramWiseReport);
router.get('/:institutionId/reports/fee-type', ctrl.getFeeTypeReport);
router.get('/:institutionId/reports/payment-method', ctrl.getPaymentMethodReport);
router.get('/:institutionId/reports/discounts', ctrl.getDiscountReport);
router.get('/:institutionId/reports/refunds', ctrl.getRefundReport);
router.get('/:institutionId/reports/collection', ctrl.getCollectionReport);

module.exports = router;
