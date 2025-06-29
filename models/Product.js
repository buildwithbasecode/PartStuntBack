// api/models/Product.js
import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  itemId: { type: String, required: true, unique: true },
  title: String,
  sku: String,
  isActive: { type: Boolean, default: true },
  competitorRule: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitorRule',
  },
  strategy: { type: mongoose.Schema.Types.ObjectId, ref: 'PricingStrategy' },
  // Listing specific price limits
  minPrice: { type: Number, default: null },
  maxPrice: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Product', ProductSchema);
