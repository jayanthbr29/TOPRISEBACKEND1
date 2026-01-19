const Payment = require("../models/paymentModel");
const Order = require("../models/order");
const Dealer = require("../models/dealer");
const razorpayInstance = require("../utils/razorPayService");
const logger = require("/packages/utils/logger");
const { sendSuccess, sendError } = require("/packages/utils/responseHandler");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const dealerAssignmentQueue = require("../queues/assignmentQueue");
const Cart = require("../models/cart");
const axios = require("axios");
const redisClient = require("/packages/utils/redisClient");
const {
  createUnicastOrMulticastNotificationUtilityFunction,
  sendOrderConfirmationEmail,
} = require("../../../../packages/utils/notificationService");
const Refund = require("../models/refund");
const ReturnModel = require("../models/return");
const { generatePdfAndUploadInvoice } = require("../../../../packages/utils/generateInvoice");
const auditLogger = require("../.././../../packages/utils/auditLoggerMiddleware");
exports.createPayment = async (req, res) => {
  try {
    const { userId, amount, orderSource, orderType, customerDetails, type_of_delivery, delivery_type } =
      req.body;
    if (!userId || !amount) {
      logger.error("User ID and amount are required");
      return sendError(res, "User ID and amount are required", 400);
    }
    // Validate input
    let razorpayOrder;
    const orderOptions = {
      amount: Math.ceil(amount) * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1,
      notes: {
        user_id: userId,
        description: "payment using Online",
        orderSource: orderSource,
        orderType: orderType,
        customerDetails: JSON.stringify(customerDetails),
        type_of_delivery: type_of_delivery,
        delivery_type: delivery_type
        //   cart_id:cart_id
      },
    };
    razorpayOrder = await razorpayInstance.orders.create(orderOptions);

    // Create a new payment record
    const payment = new Payment({
      order_id: null,
      payment_method: "Razorpay",
      razorpay_order_id: razorpayOrder.id,
      amount,
      created_at: new Date(),
      payment_status: "Created",
    });

    const savedPayment = await payment.save();

    logger.info("Payment created successfully", savedPayment);
    return sendSuccess(
      res,
      {
        payment: savedPayment,
        razorpayOrder,
        razorpayOrderId: razorpayOrder.id,
      },
      "Payment created successfully"
    );
  } catch (error) {
    logger.error("Error creating payment:", error.message);
    return sendError(res, error);
  }
};

exports.checkPaymentStatus = async (req, res) => {
  const { razorpay_order_id } = req.body;

  try {
    // Check if payment exists
    const payment = await Payment.findOne({
      razorpay_order_id: razorpay_order_id,
    });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    let orderDetails;
    // Check payment status
    const paymentStatus = await razorpayInstance.orders.fetch(
      razorpay_order_id
    );
    if (paymentStatus.status === "paid") {
      // Fetch order details if payment is successful
      orderDetails = await Order.findOne({ payment_id: payment._id });
      if (!orderDetails) {
        return res
          .status(404)
          .json({ error: "Order not found for the given payment" });
      }
    }
    // Update payment status
    payment.payment_status = paymentStatus.status;
    await payment.save();

    res.status(200).json({
      success: true,
      message: "Payment status checked",
      paymentStatus: paymentStatus.status,
      paymentDetails: paymentStatus,
      orderDetails: paymentStatus.status === "paid" ? orderDetails : null,
    });
  } catch (error) {
    console.error("Error checking payment status:", error);
    res.status(500).json({ error: "Unable to check payment status" });
  }
};

const formatDate = (date) => {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0'); // Months are 0-based
  const year = d.getFullYear();

  return `${day}-${month}-${year}`;
};

exports.verifyPayment = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"]; // Signature sent by Razorpay
  const secrete =
    process.env.RAZORPAY_WEBHOOK_KEY_DEV || "TOPRISEpaasdhahsjxa2bjshb12";
  const generated_signature = crypto.createHmac("sha256", secrete);
  generated_signature.update(JSON.stringify(req.body));
  const digested_signature = generated_signature.digest("hex");
  console.log("digested_signature", digested_signature);
  console.log("signature", signature);
  console.dir("req.body", req.body, { depth: null });
  // if (digested_signature === signature) {
  console.log("req.body.event", req.body.event);
  if (req.body.event == "payment.captured") {
    console.log("Valid signature inside payment.captured", req.body);
    console.dir(req.body, { depth: null });
    console.log(
      "Valid signature inside payment.captured",
      req.body.payload.payment.entity.notes.user_id
    );
    // Payment is valid
    const payment = await Payment.findOne({
      razorpay_order_id: req.body.payload.payment.entity.order_id,
    });
    if (!payment) {
      return res.status(200).json({ error: "Payment not found" });
    }

    // Update payment details
    payment.payment_id = req.body.payload.payment.entity.id;
    payment.payment_status = "Paid";
    payment.razorpay_payment_method = req.body.payload.payment.entity.method;
    payment.acquirer_data = req.body.payload.payment.entity.acquirer_data;
    await payment.save();
    const cart = await Cart.findOne({
      userId: req.body.payload.payment.entity.notes.user_id,
    });
    console.log("cart", cart);
    let SKU = cart.items.map((item) => {
      if (item.is_available == true) {
        return {
          sku: item.sku,
          quantity: item.quantity,
          productId: item.productId,
          productName: item.product_name,
          selling_price: item.selling_price,
          product_image: item.product_image,
          manufacturer_part_name: item.manufacturer_part_name,
          mrp: item.mrp,
          mrp_gst_amount: item.mrp_gst_amount,
          gst_percentage: item.gst_percentage,
          gst_amount: item.gst_amount,
          product_total: item.product_total,
          totalPrice: item.totalPrice,
        }
      } else {
        return null;
      }
    });
    
    SKU = SKU.filter(item => item !== null);
    console.log("SKU", SKU);
    const orderId = `ORD-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const orderPayload = {
      orderId,
      orderSource: req.body.payload.payment.entity.notes.orderSource,
      orderType: req.body.payload.payment.entity.notes.orderType,
      type_of_delivery: req.body.payload.payment.entity.notes.type_of_delivery,
      delivery_type: req.body.payload.payment.entity.notes.delivery_type,
      order_Amount: req.body.payload.payment.entity.amount / 100,
      paymentType: "Prepaid",
      orderDate: new Date(),
      status: "Confirmed",
      timestamps: { createdAt: new Date() },
      // ensure skus have uppercase SKU and empty dealerMapping slots
      skus: SKU.map((s) => ({
        sku: String(s.sku).toUpperCase().trim(),
        quantity: s.quantity,
        productId: s.productId,
        productName: s.productName,
        manufacturer_part_name: s.manufacturer_part_name,
        product_image: s.product_image,
        selling_price: s.selling_price,
        dealerMapped: [], // will be populated by the worker
        mrp: s.mrp,
        mrp_gst_amount: s.mrp_gst_amount,
        gst_percentage: s.gst_percentage,
        gst_amount: s.gst_amount,
        product_total: s.product_total,
        totalPrice: s.totalPrice,
      })),
      dealerMapping: [], // populated by the worker
      customerDetails: JSON.parse(
        req.body.payload.payment.entity.notes.customerDetails
      ),
      payment_id: payment._id, // link payment to order
      GST: cart.gst_amount,
      deliveryCharges: cart.deliveryCharge,
      ordered_pincode: cart.pincode||req.body.payload.payment.entity.notes.customerDetails.pincode,
    };
    const newOrder = await Order.create(orderPayload);


    const invoiceNumber = `INV-${Date.now()}`;
    const customerDetails = newOrder.customerDetails;
    const items = await Promise.all(newOrder.skus.map(async (s) => {
      //call product service to get product name
      const productResponse = await axios.get(`http://product-service:5001/products/v1/sku/${s.sku}`);
      const productData = productResponse.data.data;

      // if customer address is from delhi means it contains delhi in address then make scgst and cgst 0  and make igst= scgst+cgst
      const scgst = (s.gst_percentage || 0) / 2;
      const cgst = (s.gst_percentage || 0) / 2;
      const igst = scgst + cgst;
      const lowerCaseAddress = customerDetails?.address?.toLowerCase();
      const containsDelhi = lowerCaseAddress.includes('delhi');
      console.log("containsDelhi", containsDelhi);
      if (containsDelhi) {
        return ({
          productName: s.productName,
          sku: s.sku,
          hsn: productData?.hsn_code || "N/A",
          mpn: productData?.manufacturer_part_name || "N/A",
          unitPrice: s.selling_price,
          quantity: s.quantity,
          taxRate: `${igst || 0}%`,
          cgstPercent: 0,
          cgstAmount: 0,
          sgstPercent: 0,
          sgstAmount: 0,
          igstPercent: igst || 0,
          igstAmount: s.gst_amount || 0,
          totalAmount: s.totalPrice,
        });
      } else {
        return ({
          productName: s.productName,
          sku: s.sku,
          hsn: productData?.hsn_code || "N/A",
          mpn: productData?.manufacturer_part_name || "N/A",
          unitPrice: s.selling_price,
          quantity: s.quantity,
          taxRate: `${s.gst_percentage || 0}%`,
          cgstPercent: (s.gst_percentage || 0) / 2,
          cgstAmount: (s.gst_amount || 0) / 2,
          sgstPercent: (s.gst_percentage || 0) / 2,
          sgstAmount: (s.gst_amount || 0) / 2,
          totalAmount: s.totalPrice,
        });
      }

    }));
    const shippingCharges = Number(cart.deliveryCharge) || 0;
    const totalOrderAmount = Number((req.body.payload.payment.entity.amount / 100)) || 0;

    console.log("🧾 Generating invoice for order:", invoiceNumber, customerDetails, items, shippingCharges, totalOrderAmount);
    let invoiceResult;
    try {
      invoiceResult = await generatePdfAndUploadInvoice(
        customerDetails,
        newOrder.orderId,
        formatDate(newOrder.orderDate),
        "Delhi", // Place of supply
        customerDetails.address, // Place of delivery
        items,
        shippingCharges,
        totalOrderAmount,
        invoiceNumber
      );
    } catch (error) {
      console.error("Error generating invoice:", error);
    }

    newOrder.invoiceNumber = invoiceNumber;
    newOrder.invoiceUrl = invoiceResult?.Location || null;
    await newOrder.save();
    // console.log("newOrder", newOrder);
    payment.order_id = newOrder._id; // link payment to order
    await payment.save();

    if (!cart) {
      logger.error(
        `❌ Cart not found for user: ${req.body.payload.payment.entity.notes.user_id}`
      );
    } else {
      cart.items = cart.items.filter(item => item.is_available == false);
      cart.totalPrice = 0;
      cart.itemTotal = 0;
      cart.handlingCharge = 0;
      cart.deliveryCharge = 0;
      cart.gst_amount = 0;
      cart.total_mrp = 0;
      cart.total_mrp_gst_amount = 0;
      cart.total_mrp_with_gst = 0;
      cart.grandTotal = 0;
      await cart.save();
      logger.info(
        `✅ Cart cleared for user: ${req.body.payload.payment.entity.notes.user_id}`
      );
    }
    await dealerAssignmentQueue.add(
      { orderId: newOrder._id.toString() },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    logger.info(`✅ Order created with ID: ${newOrder._id}`);
    //  push Notification

    let tokenDummy;
    // const successData =
    //   await createUnicastOrMulticastNotificationUtilityFunction(
    //     [req.body.payload.payment.entity.notes.user_id],
    //     ["INAPP", "PUSH", "EMAIL"],
    //     "Order Placed",
    //     `Order Placed Successfully with order id ${orderId}`,
    //     "",
    //     "",
    //     "Order",
    //     {
    //       order_id: newOrder._id,
    //     },
    //     tokenDummy
    //   );
    // if (!successData.success) {
    //   console.log(successData);
    //   logger.error("❌ Create notification error:", successData.message);
    // } else {
    //   logger.info(
    //     "✅ Notification created successfully",
    //     successData.message
    //   );
    // }
    //create audit log
    try {
      auditLogger("Order_Created_Prepaid", "ORDER");
    } catch (e) {
      console.log(e)
    }

    // Send order confirmation email
    // try {
    //   const emailResult = await sendOrderConfirmationEmail(
    //     newOrder.customerDetails.email,
    //     newOrder,
    //     req.headers.authorization
    //   );
    //   if (emailResult.success) {
    //     logger.info("✅ Order confirmation email sent successfully");
    //   } else {
    //     logger.error("❌ Failed to send order confirmation email:", emailResult.message);
    //   }
    // } catch (emailError) {
    //   logger.error("❌ Error sending order confirmation email:", emailError);
    // }
    // Get Super-admin users for notification (using internal endpoint)
    // let superAdminIds = [];
    // try {
    //   const userData = await axios.get(
    //     "http://user-service:5001/api/users/internal/super-admins"
    //   );
    //   if (userData.data.success) {
    //     superAdminIds = userData.data.data.map((u) => u._id);
    //   }
    // } catch (error) {
    //   logger.warn("Failed to fetch Super-admin users for notification:", error.message);
    // }

    // const notify = await createUnicastOrMulticastNotificationUtilityFunction(
    //   superAdminIds,
    //   ["INAPP", "PUSH", "EMAIL"],
    //   "Order Created Alert",
    //   `Order Placed Successfully with order id ${orderId}`,
    //   "",
    //   "",
    //   "Order",
    //   {
    //     order_id: newOrder._id,
    //   },
    //   req.headers.authorization
    // );
    // if (!notify.success)
    //   logger.error("❌ Create notification error:", notify.message);
    // else logger.info("✅ Notification created successfully");
  } else if (req.body.event == "payment.failed") {
    console.log("Valid signature inside payment.failed", req.body);
    console.dir(req.body, { depth: null });
    const payment = await Payment.findOne({
      razorpay_order_id: req.body.payload.payment.entity.order_id,
    });
    if (!payment) {
      return res.status(200).json({ error: "Payment not found" });
    }
    // Update payment details
    payment.status = "Failed";
    await payment.save();
  } else if (req.body.event === 'refund.processed') {
    console.log("inside refund", req.body.payload.refund)
    const returnData = await ReturnModel.findById(req.body.payload.refund.entity.notes.return_id);
    if (!returnData) {
      return res.status(200).json({ error: "Return not found" });
    }
    returnData.returnStatus = "Refund_Completed";
    returnData.timestamps.refundCompletedAt = new Date();
    returnData.refund.refundStatus = "Processed";
    await returnData.save();

    const refund = await Refund.findOne({
      razorpay_refund_id: req.body.payload.refund.entity.id,
    })
    if (!refund) {
      return res.status(200).json({ error: "Refund not found" });
    }
    refund.status = "Processed";
    await refund.save();
  } else if (req.body.event === 'refund.failed') {
    console.log("inside refund",)
    const returnData = await ReturnModel.findById(req.body.payload.refund.entity.notes.return_id);
    if (!returnData) {
      return res.status(200).json({ error: "Return not found" });
    }
    returnData.returnStatus = "Refund_Failed";
    returnData.timestamps.refundCompletedAt = new Date();
    returnData.refund.refundStatus = "Failed";
    await returnData.save();

    const refund = await Refund.findOne({
      razorpay_refund_id: req.body.payload.refund.entity.id,
    })
    if (!refund) {
      return res.status(200).json({ error: "Refund not found" });
    }
    refund.status = "Failed";
    await refund.save();

  } else if (req.body.event === "payout.processed") {
    console.log("inside refund", req.body.payload.refund)
    const returnData = await ReturnModel.findById(req.body.payload.payout.entity.notes.return_id);
    if (!returnData) {
      return res.status(200).json({ error: "Return not found" });
    }
    returnData.refund.refundStatus = "Processed";
    await returnData.save();

    const refund = await Refund.findOne({
      razorpay_payout_id: req.body.payload.payout.entity.id,
    })
    if (!refund) {
      return res.status(200).json({ error: "Refund not found" });
    }
    refund.status = "Processed";
    await refund.save();

  } else if (req.body.event === "payout.failed") {
    const returnData = await ReturnModel.findById(req.body.payload.payout.entity.notes.return_id);
    if (!returnData) {
      return res.status(200).json({ error: "Return not found" });
    }
    returnData.refund.refundStatus = "Failed";
    await returnData.save();

    const refund = await Refund.findOne({
      razorpay_payout_id: req.body.payload.payout.entity.id,
    })
    if (!refund) {
      return res.status(200).json({ error: "Refund not found" });
    }
    refund.status = "Failed";
    await refund.save();
  }
  // } else {
  //   console.log("Invalid signature");
  // }

  res.json({ status: "ok" });
};

exports.getPaymentDetails = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const { payment_status, payment_method, startDate, endDate, razorpay_payment_method, sort } = req.query;
    console.log("query", req.query)
    // Build filter
    const filter = {};
    if (payment_status !== "all") filter.payment_status = payment_status;
    if (payment_method !== "all") filter.payment_method = payment_method;
    if (payment_method === "Razorpay" && razorpay_payment_method && razorpay_payment_method !== "all") {
      filter.razorpay_payment_method = razorpay_payment_method;
    }
    if (startDate || endDate) {
      filter.created_at = {};
      if (startDate) filter.created_at.$gte = new Date(startDate);
      if (endDate) {
        filter.created_at.$lte = new Date(endDate);
        //set end date hours to 23:59:59
        filter.created_at.$lte.setHours(23);
        filter.created_at.$lte.setMinutes(59);
        filter.created_at.$lte.setSeconds(59);

      }
    }
    console.log("filter", filter)
    const sortOptions = {};
    if (sort) {
      if (sort == "asc") {
        sortOptions.amount = 1;
      } else if (sort == "desc") {
        sortOptions.amount = -1;
      }
    } else {
      sortOptions.created_at = -1;
    }

    const totalPayments = await Payment.countDocuments(filter)
      ;

    // Populate order with comprehensive details
    const paymentDetails = await Payment.find(filter)
      .populate({
        path: "order_id",
        select: "orderId orderDate totalAmount orderType orderSource status customerDetails paymentType skus order_Amount GST deliveryCharges timestamps type_of_delivery trackingInfo invoiceNumber purchaseOrderId slaInfo order_track_info",
        populate: {
          path: "skus.dealerMapped.dealerId",
          select: "trade_name legal_name email phone_Number dealer_code",
          model: "Dealer"
        }
      })
      .sort(sortOptions)
      .skip(skip)
      .limit(limit);
    console.log("paymentDetails", paymentDetails);

    // Enhance each payment with comprehensive order details
    const enhancedPayments = paymentDetails.map(payment => ({
      ...payment.toObject(),
      orderDetails: payment.order_id ? {
        _id: payment.order_id._id,
        orderId: payment.order_id.orderId,
        orderDate: payment.order_id.orderDate,
        totalAmount: payment.order_id.totalAmount,
        orderType: payment.order_id.orderType,
        orderSource: payment.order_id.orderSource,
        status: payment.order_id.status,
        customerDetails: payment.order_id.customerDetails,
        paymentType: payment.order_id.paymentType,
        skus: payment.order_id.skus,
        order_Amount: payment.order_id.order_Amount,
        GST: payment.order_id.GST,
        deliveryCharges: payment.order_id.deliveryCharges,
        timestamps: payment.order_id.timestamps,
        type_of_delivery: payment.order_id.type_of_delivery,
        trackingInfo: payment.order_id.trackingInfo,
        invoiceNumber: payment.order_id.invoiceNumber,
        purchaseOrderId: payment.order_id.purchaseOrderId,
        slaInfo: payment.order_id.slaInfo,
        order_track_info: payment.order_id.order_track_info,
        // Computed fields
        skuCount: payment.order_id.skus?.length || 0,
        totalSKUs: payment.order_id.skus?.reduce((total, sku) => total + sku.quantity, 0) || 0,
        customerName: payment.order_id.customerDetails?.name || 'N/A',
        customerEmail: payment.order_id.customerDetails?.email || 'N/A',
        customerPhone: payment.order_id.customerDetails?.phone || 'N/A',
        // Dealer information
        dealers: payment.order_id.skus?.flatMap(sku =>
          sku.dealerMapped?.map(dealer => ({
            dealerId: dealer.dealerId?._id,
            dealerName: dealer.dealerId?.trade_name || dealer.dealerId?.legal_name,
            dealerCode: dealer.dealerId?.dealer_code,
            dealerEmail: dealer.dealerId?.email,
            dealerPhone: dealer.dealerId?.phone_Number
          })) || []
        ) || []
      } : null,
      paymentSummary: {
        paymentId: payment._id,
        razorpayOrderId: payment.razorpay_order_id,
        paymentMethod: payment.payment_method,
        paymentStatus: payment.payment_status,
        amount: payment.amount,
        razorpayPaymentId: payment.payment_id,
        createdAt: payment.created_at,
        isRefund: payment.is_refund,
        refundId: payment.refund_id,
        refundStatus: payment.refund_status,
        refundSuccessful: payment.refund_successful,
        acquirerData: payment.acquirer_data
      }
    }));

    const totalPages = Math.ceil(totalPayments / limit);

    return sendSuccess(
      res,
      {
        data: enhancedPayments,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          totalItems: totalPayments,
          itemsPerPage: limit,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
        filters: {
          payment_status,
          payment_method,
          startDate,
          endDate
        }
      },
      "Payment details with comprehensive order information retrieved successfully"
    );
  } catch (error) {
    logger.error("Error fetching payment details:", error.message);
    return sendError(res, error);
  }
};

exports.getPaymentById = async (req, res) => {
  try {
    const { paymentId } = req.params;

    // Populate order with specific fields for better performance and clarity
    const payment = await Payment.findById(paymentId).populate({
      path: "order_id",
      select: "orderId orderDate totalAmount orderType orderSource status customerDetails paymentType skus order_Amount GST deliveryCharges timestamps type_of_delivery trackingInfo invoiceNumber purchaseOrderId",
      populate: {
        path: "skus.dealerMapped.dealerId",
        select: "trade_name legal_name email phone_Number",
        model: "Dealer"
      }
    });

    if (!payment) {
      logger.error("Payment not found");
      return sendError(res, "Payment not found", 404);
    }

    // Enhance the response with additional computed fields
    const enhancedPayment = {
      ...payment.toObject(),
      orderSummary: payment.order_id ? {
        orderId: payment.order_id.orderId,
        orderDate: payment.order_id.orderDate,
        totalAmount: payment.order_id.totalAmount,
        orderType: payment.order_id.orderType,
        orderSource: payment.order_id.orderSource,
        status: payment.order_id.status,
        customerName: payment.order_id.customerDetails?.name,
        customerEmail: payment.order_id.customerDetails?.email,
        customerPhone: payment.order_id.customerDetails?.phone,
        paymentType: payment.order_id.paymentType,
        skuCount: payment.order_id.skus?.length || 0,
        totalSKUs: payment.order_id.skus?.reduce((total, sku) => total + sku.quantity, 0) || 0,
        gstAmount: payment.order_id.GST,
        deliveryCharges: payment.order_id.deliveryCharges,
        invoiceNumber: payment.order_id.invoiceNumber,
        purchaseOrderId: payment.order_id.purchaseOrderId,
        trackingInfo: payment.order_id.trackingInfo,
        timestamps: payment.order_id.timestamps
      } : null,
      paymentSummary: {
        paymentId: payment._id,
        razorpayOrderId: payment.razorpay_order_id,
        paymentMethod: payment.payment_method,
        paymentStatus: payment.payment_status,
        amount: payment.amount,
        paymentId: payment.payment_id,
        createdAt: payment.created_at,
        isRefund: payment.is_refund,
        refundStatus: payment.refund_status,
        refundSuccessful: payment.refund_successful
      }
    };

    return sendSuccess(res, enhancedPayment, "Payment details retrieved successfully");
  } catch (error) {
    logger.error("Error fetching payment details:", error.message);
    return sendError(res, error);
  }
};

exports.getPaymentByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    // Populate order with specific fields for better performance and clarity
    const payments = await Payment.find({ order_id: orderId }).populate({
      path: "order_id",
      select: "orderId orderDate totalAmount orderType orderSource status customerDetails paymentType skus order_Amount GST deliveryCharges timestamps type_of_delivery trackingInfo invoiceNumber purchaseOrderId slaInfo order_track_info",
      populate: {
        path: "skus.dealerMapped.dealerId",
        select: "trade_name legal_name email phone_Number dealer_code",
        model: "Dealer"
      }
    });

    if (!payments || payments.length === 0) {
      logger.error("Payment not found for the given order ID");
      return sendError(res, "Payment not found for the given order ID", 404);
    }

    // Enhance each payment with additional computed fields
    const enhancedPayments = payments.map(payment => ({
      ...payment.toObject(),
      orderDetails: payment.order_id ? {
        _id: payment.order_id._id,
        orderId: payment.order_id.orderId,
        orderDate: payment.order_id.orderDate,
        totalAmount: payment.order_id.totalAmount,
        orderType: payment.order_id.orderType,
        orderSource: payment.order_id.orderSource,
        status: payment.order_id.status,
        customerDetails: payment.order_id.customerDetails,
        paymentType: payment.order_id.paymentType,
        skus: payment.order_id.skus,
        order_Amount: payment.order_id.order_Amount,
        GST: payment.order_id.GST,
        deliveryCharges: payment.order_id.deliveryCharges,
        timestamps: payment.order_id.timestamps,
        type_of_delivery: payment.order_id.type_of_delivery,
        trackingInfo: payment.order_id.trackingInfo,
        invoiceNumber: payment.order_id.invoiceNumber,
        purchaseOrderId: payment.order_id.purchaseOrderId,
        slaInfo: payment.order_id.slaInfo,
        order_track_info: payment.order_id.order_track_info,
        // Computed fields
        skuCount: payment.order_id.skus?.length || 0,
        totalSKUs: payment.order_id.skus?.reduce((total, sku) => total + sku.quantity, 0) || 0,
        customerName: payment.order_id.customerDetails?.name || 'N/A',
        customerEmail: payment.order_id.customerDetails?.email || 'N/A',
        customerPhone: payment.order_id.customerDetails?.phone || 'N/A',
        // Dealer information
        dealers: payment.order_id.skus?.flatMap(sku =>
          sku.dealerMapped?.map(dealer => ({
            dealerId: dealer.dealerId?._id,
            dealerName: dealer.dealerId?.trade_name || dealer.dealerId?.legal_name,
            dealerCode: dealer.dealerId?.dealer_code,
            dealerEmail: dealer.dealerId?.email,
            dealerPhone: dealer.dealerId?.phone_Number
          })) || []
        ) || []
      } : null,
      paymentSummary: {
        paymentId: payment._id,
        razorpayOrderId: payment.razorpay_order_id,
        paymentMethod: payment.payment_method,
        paymentStatus: payment.payment_status,
        amount: payment.amount,
        razorpayPaymentId: payment.payment_id,
        createdAt: payment.created_at,
        isRefund: payment.is_refund,
        refundId: payment.refund_id,
        refundStatus: payment.refund_status,
        refundSuccessful: payment.refund_successful,
        acquirerData: payment.acquirer_data
      }
    }));

    return sendSuccess(res, enhancedPayments, "Payment details retrieved successfully");
  } catch (error) {
    logger.error("Error fetching payment details:", error.message);
    return sendError(res, error);
  }
};

// Enhanced payment search with comprehensive filtering
exports.searchPaymentsWithOrderDetails = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const {
      search,
      payment_status,
      payment_method,
      order_status,
      order_type,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      customerEmail,
      customerPhone,
      dealerId
    } = req.query;

    // Build base filter
    const filter = {};
    if (payment_status) filter.payment_status = payment_status;
    if (payment_method) filter.payment_method = payment_method;
    if (startDate || endDate) {
      filter.created_at = {};
      if (startDate) filter.created_at.$gte = new Date(startDate);
      if (endDate) filter.created_at.$lte = new Date(endDate);
    }
    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = parseFloat(minAmount);
      if (maxAmount) filter.amount.$lte = parseFloat(maxAmount);
    }

    // Build order filter for aggregation
    const orderFilter = {};
    if (order_status) orderFilter['order_id.status'] = order_status;
    if (order_type) orderFilter['order_id.orderType'] = order_type;
    if (customerEmail) orderFilter['order_id.customerDetails.email'] = new RegExp(customerEmail, 'i');
    if (customerPhone) orderFilter['order_id.customerDetails.phone'] = new RegExp(customerPhone, 'i');

    // Build aggregation pipeline
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'orders',
          localField: 'order_id',
          foreignField: '_id',
          as: 'order_id',
          pipeline: [
            {
              $lookup: {
                from: 'dealers',
                localField: 'skus.dealerMapped.dealerId',
                foreignField: '_id',
                as: 'dealerDetails'
              }
            }
          ]
        }
      },
      { $unwind: { path: '$order_id', preserveNullAndEmptyArrays: true } }
    ];

    // Add order filters if specified
    if (Object.keys(orderFilter).length > 0) {
      pipeline.push({ $match: orderFilter });
    }

    // Add dealer filter if specified
    if (dealerId) {
      pipeline.push({
        $match: {
          'order_id.skus.dealerMapped.dealerId': new mongoose.Types.ObjectId(dealerId)
        }
      });
    }

    // Add search functionality
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { razorpay_order_id: new RegExp(search, 'i') },
            { payment_id: new RegExp(search, 'i') },
            { 'order_id.orderId': new RegExp(search, 'i') },
            { 'order_id.customerDetails.name': new RegExp(search, 'i') },
            { 'order_id.customerDetails.email': new RegExp(search, 'i') },
            { 'order_id.customerDetails.phone': new RegExp(search, 'i') },
            { 'order_id.invoiceNumber': new RegExp(search, 'i') },
            { 'order_id.purchaseOrderId': new RegExp(search, 'i') }
          ]
        }
      });
    }

    // Add sorting and pagination
    pipeline.push(
      { $sort: { created_at: -1 } },
      { $skip: skip },
      { $limit: limit }
    );

    // Get total count for pagination
    const countPipeline = [...pipeline];
    countPipeline.splice(-2); // Remove skip and limit
    countPipeline.push({ $count: 'total' });

    const [payments, countResult] = await Promise.all([
      Payment.aggregate(pipeline),
      Payment.aggregate(countPipeline)
    ]);

    const totalPayments = countResult[0]?.total || 0;

    // Enhance payments with computed fields
    const enhancedPayments = payments.map(payment => ({
      ...payment,
      orderDetails: payment.order_id ? {
        _id: payment.order_id._id,
        orderId: payment.order_id.orderId,
        orderDate: payment.order_id.orderDate,
        totalAmount: payment.order_id.totalAmount,
        orderType: payment.order_id.orderType,
        orderSource: payment.order_id.orderSource,
        status: payment.order_id.status,
        customerDetails: payment.order_id.customerDetails,
        paymentType: payment.order_id.paymentType,
        skus: payment.order_id.skus,
        order_Amount: payment.order_id.order_Amount,
        GST: payment.order_id.GST,
        deliveryCharges: payment.order_id.deliveryCharges,
        timestamps: payment.order_id.timestamps,
        type_of_delivery: payment.order_id.type_of_delivery,
        trackingInfo: payment.order_id.trackingInfo,
        invoiceNumber: payment.order_id.invoiceNumber,
        purchaseOrderId: payment.order_id.purchaseOrderId,
        slaInfo: payment.order_id.slaInfo,
        order_track_info: payment.order_id.order_track_info,
        // Computed fields
        skuCount: payment.order_id.skus?.length || 0,
        totalSKUs: payment.order_id.skus?.reduce((total, sku) => total + sku.quantity, 0) || 0,
        customerName: payment.order_id.customerDetails?.name || 'N/A',
        customerEmail: payment.order_id.customerDetails?.email || 'N/A',
        customerPhone: payment.order_id.customerDetails?.phone || 'N/A',
        // Dealer information
        dealers: payment.order_id.skus?.flatMap(sku =>
          sku.dealerMapped?.map(dealer => ({
            dealerId: dealer.dealerId,
            dealerName: payment.order_id.dealerDetails?.find(d => d._id.toString() === dealer.dealerId?.toString())?.trade_name ||
              payment.order_id.dealerDetails?.find(d => d._id.toString() === dealer.dealerId?.toString())?.legal_name,
            dealerCode: payment.order_id.dealerDetails?.find(d => d._id.toString() === dealer.dealerId?.toString())?.dealer_code,
            dealerEmail: payment.order_id.dealerDetails?.find(d => d._id.toString() === dealer.dealerId?.toString())?.email,
            dealerPhone: payment.order_id.dealerDetails?.find(d => d._id.toString() === dealer.dealerId?.toString())?.phone_Number
          })) || []
        ) || []
      } : null,
      paymentSummary: {
        paymentId: payment._id,
        razorpayOrderId: payment.razorpay_order_id,
        paymentMethod: payment.payment_method,
        paymentStatus: payment.payment_status,
        amount: payment.amount,
        razorpayPaymentId: payment.payment_id,
        createdAt: payment.created_at,
        isRefund: payment.is_refund,
        refundId: payment.refund_id,
        refundStatus: payment.refund_status,
        refundSuccessful: payment.refund_successful,
        acquirerData: payment.acquirer_data
      }
    }));

    const totalPages = Math.ceil(totalPayments / limit);

    return sendSuccess(
      res,
      {
        data: enhancedPayments,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          totalItems: totalPayments,
          itemsPerPage: limit,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
        filters: {
          search,
          payment_status,
          payment_method,
          order_status,
          order_type,
          startDate,
          endDate,
          minAmount,
          maxAmount,
          customerEmail,
          customerPhone,
          dealerId
        }
      },
      "Enhanced payment search with comprehensive order details completed successfully"
    );
  } catch (error) {
    logger.error("Error in enhanced payment search:", error.message);
    return sendError(res, error);
  }
};


exports.getPaymentDetailsNoPagination = async (req, res) => {
  try {
    const {
      payment_status,
      payment_method,
      startDate,
      endDate,
      razorpay_payment_method,
      sort
    } = req.query;

    console.log("query", req.query);

    // ---------------------------
    // BUILD FILTER
    // ---------------------------
    const filter = {};

    if (payment_status && payment_status !== "all")
      filter.payment_status = payment_status;

    if (payment_method && payment_method !== "all")
      filter.payment_method = payment_method;

    if (
      payment_method === "Razorpay" &&
      razorpay_payment_method &&
      razorpay_payment_method !== "all"
    ) {
      filter.razorpay_payment_method = razorpay_payment_method;
    }

    // Date Filtering
    if (startDate || endDate) {
      filter.created_at = {};
      if (startDate) filter.created_at.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.created_at.$lte = end;
      }
    }

    console.log("filter", filter);

    // Sorting
    const sortOptions = {};
    if (sort) {
      if (sort === "asc") sortOptions.amount = 1;
      else if (sort === "desc") sortOptions.amount = -1;
    } else {
      sortOptions.created_at = -1;
    }

    // ---------------------------
    // FETCH ALL PAYMENTS (NO LIMITS)
    // ---------------------------
    const paymentDetails = await Payment.find(filter)
      .populate({
        path: "order_id",
        select:
          "orderId orderDate totalAmount orderType orderSource status customerDetails paymentType skus order_Amount GST deliveryCharges timestamps type_of_delivery trackingInfo invoiceNumber purchaseOrderId slaInfo order_track_info",
        populate: {
          path: "skus.dealerMapped.dealerId",
          model: "Dealer",
          select: "trade_name legal_name email phone_Number dealer_code"
        }
      })
      .sort(sortOptions);

    console.log("paymentDetails", paymentDetails);

    // ---------------------------
    // ENHANCE PAYMENT RESPONSE
    // ---------------------------
    const enhancedPayments = paymentDetails.map((payment) => ({
      ...payment.toObject(),

      orderDetails: payment.order_id
        ? {
          _id: payment.order_id._id,
          orderId: payment.order_id.orderId,
          orderDate: payment.order_id.orderDate,
          totalAmount: payment.order_id.totalAmount,
          orderType: payment.order_id.orderType,
          orderSource: payment.order_id.orderSource,
          status: payment.order_id.status,
          customerDetails: payment.order_id.customerDetails,
          paymentType: payment.order_id.paymentType,
          skus: payment.order_id.skus,
          order_Amount: payment.order_id.order_Amount,
          GST: payment.order_id.GST,
          deliveryCharges: payment.order_id.deliveryCharges,
          timestamps: payment.order_id.timestamps,
          type_of_delivery: payment.order_id.type_of_delivery,
          trackingInfo: payment.order_id.trackingInfo,
          invoiceNumber: payment.order_id.invoiceNumber,
          purchaseOrderId: payment.order_id.purchaseOrderId,
          slaInfo: payment.order_id.slaInfo,
          order_track_info: payment.order_id.order_track_info,

          // Computed fields
          skuCount: payment.order_id.skus?.length || 0,
          totalSKUs:
            payment.order_id.skus?.reduce(
              (t, sku) => t + sku.quantity,
              0
            ) || 0,

          customerName: payment.order_id.customerDetails?.name || "N/A",
          customerEmail: payment.order_id.customerDetails?.email || "N/A",
          customerPhone: payment.order_id.customerDetails?.phone || "N/A",

          // Dealer info
          dealers:
            payment.order_id.skus?.flatMap((sku) =>
              sku.dealerMapped?.map((dealer) => ({
                dealerId: dealer.dealerId?._id,
                dealerName:
                  dealer.dealerId?.trade_name ||
                  dealer.dealerId?.legal_name,
                dealerCode: dealer.dealerId?.dealer_code,
                dealerEmail: dealer.dealerId?.email,
                dealerPhone: dealer.dealerId?.phone_Number
              })) || []
            ) || []
        }
        : null,

      paymentSummary: {
        paymentId: payment._id,
        razorpayOrderId: payment.razorpay_order_id,
        paymentMethod: payment.payment_method,
        paymentStatus: payment.payment_status,
        amount: payment.amount,
        razorpayPaymentId: payment.payment_id,
        createdAt: payment.created_at,
        isRefund: payment.is_refund,
        refundId: payment.refund_id,
        refundStatus: payment.refund_status,
        refundSuccessful: payment.refund_successful,
        acquirerData: payment.acquirer_data
      }
    }));

    // ---------------------------
    // RETURN RESPONSE (NO PAGINATION)
    // ---------------------------
    return sendSuccess(
      res,
      {
        data: enhancedPayments,
        totalItems: enhancedPayments.length,
        filters: {
          payment_status,
          payment_method,
          razorpay_payment_method,
          startDate,
          endDate,
          sort
        }
      },
      "Payment details retrieved successfully (no pagination)"
    );
  } catch (error) {
    console.error("Error fetching payment details:", error);
    return sendError(res, error?.message || "Internal server error", 500);
  }
};
