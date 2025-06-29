import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import jwt from 'jsonwebtoken';

// Set test JWT secret before importing middleware/routes
process.env.JWT_SECRET = 'testsecret';

import Product from '../models/Product.js';
import User from '../models/Users.js';
import supertest from 'supertest';

async function run() {
  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), {});

  // create test user and product
  const user = await User.create({ email: 'test@example.com', password: 'pass' });
  await Product.create({ itemId: 'ITEM1', title: 'Test Listing', minPrice: 5, maxPrice: 15 });

  // dynamically import routes after setting JWT secret
  const { default: inventoryRoutes } = await import('../routes/inventory.js');

  // create express app
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', inventoryRoutes);

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

  await supertest(app)
    .put('/api/inventory/pricing/ITEM1')
    .set('Authorization', `Bearer ${token}`)
    .send({ minPrice: 6, maxPrice: 14 })
    .expect(200);

  const updated = await Product.findOne({ itemId: 'ITEM1' });
  if (updated.minPrice !== 6 || updated.maxPrice !== 14) {
    throw new Error('Listing pricing route did not update product');
  }

  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('updateListingPricingRoute test passed');
}

run();
