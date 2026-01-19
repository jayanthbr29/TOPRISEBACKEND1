const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema({
  productId: {
    type: String,
    required: true,
  },
  sku: {
    type: String,
    required: true,
  },
  product_name: {
    type: String,
    required: true,
  },
  product_image: [
    {
      type: String,
      required: true,
    },
  ],
  quantity: {
    type: Number,
    required: true,
    min: [1, "Quantity must be at least 1"],
    default: 1,
  },
  selling_price: {
    type: Number,
    required: true,
  },
  gst_percentage: {
    type: String,
    required: true,
  },
  mrp: {
    type: Number,
    required: true,
  },
  mrp_gst_amount: {
    type: Number,
    required: true,
  },
  total_mrp: {
    type: Number,
    required: true,
  },
  gst_amount: {
    type: Number,
    required: true,
  },
  product_total: {
    type: Number,
    required: true,
  },
  totalPrice: {
    type: Number,
    required: true,
  },
  is_available: {
    type: Boolean,
    default: true,
  },
  manufacturer_part_name: {
    type: String,
    // required: true,
  },
});

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    items: [cartItemSchema],
    itemTotal: {
      type: Number,
      default: 0,
    },

    totalPrice: {
      type: Number,
      default: 0,
    },
    handlingCharge: {
      type: Number,
      default: 0,
    },
    deliveryCharge: {
      type: Number,
      default: 0,
    },
    gst_amount: {
      type: Number,
      default: 0,
    },
    total_mrp: {
      type: Number,
      default: 0,
    },
    total_mrp_gst_amount: {
      type: Number,
      default: 0,
    },
    type_of_delivery: {
      type: String,
    },
    delivery_type: {
      type: String,
    },
    total_mrp_with_gst: {
      type: Number,
      default: 0,
    },
    grandTotal: {
      type: Number,
      default: 0,
    },
    pincode: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Cart || mongoose.model("Cart", cartSchema);
