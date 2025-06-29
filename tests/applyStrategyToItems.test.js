import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import PricingStrategy from '../models/PricingStrategy.js';
import Product from '../models/Product.js';
import { applyStrategyToItems } from '../services/strategyService.js';

async function run() {
  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), {});

  const strategy = await PricingStrategy.create({
    strategyName: 'Test Strategy',
    repricingRule: 'MATCH_LOWEST',
  });

  await Product.create({ itemId: 'TEST123', title: 'Test Listing' });

  await applyStrategyToItems(strategy._id, [
    { itemId: 'TEST123', minPrice: 5, maxPrice: 10 },
  ]);

  const updated = await Product.findOne({ itemId: 'TEST123' });
  if (updated.minPrice !== 5 || updated.maxPrice !== 10) {
    throw new Error('Listing price limits not updated correctly');
  }

  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('applyStrategyToItems test passed');
}

run();
