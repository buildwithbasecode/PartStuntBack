// routes/pricingStrategyRoutes.js

import express from 'express';
import {
  createPricingStrategy,
  getAllPricingStrategies,
  getPricingStrategy,
  updatePricingStrategy,
  deletePricingStrategy,
  applyStrategyToItemsController,
  getStrategiesForItemController,
  removeStrategyFromItemController,
  getActivePricingStrategies,
  getStrategyDisplayForProductController,
  executeAllStrategiesController,
  executeStrategiesForItemController,
} from '../controllers/pricingStrategyController.js';
import PricingStrategy from '../models/PricingStrategy.js';
import { getStrategiesForItem } from '../services/strategyService.js';


const router = express.Router();

// 1) Create a new strategy WITHOUT applying it to any listing
//    POST /api/pricing-strategies
router.post('/', async (req, res) => {
  try {

    const strategy = await createPricingStrategy({
      ...req.body,
      createdBy: req.user.id,
    });



    return res.status(201).json({
      success: true,
      data: strategy,
      message: `Strategy "${strategy.strategyName}" created successfully. You can now apply it to specific listings.`,
    });
  } catch (err) {
    console.error('Error in POST /api/pricing-strategies:', err.message);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 2) Get all strategies (optional: ?active=true|false)
//    GET /api/pricing-strategies
router.get('/', async (req, res) => {
  try {
    const { active } = req.query;
    let isActive = null;
    if (active === 'true') isActive = true;
    else if (active === 'false') isActive = false;

    const strategies = await getAllPricingStrategies(isActive);
    return res.status(200).json({
      success: true,
      strategies, // Wrap strategies in the specified format
      rules: [], // Placeholder for rulesData if applicable
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2.5) Get active listings with strategies
//      GET /api/pricing-strategies/active-listings
router.get('/active-listings', async (req, res) => {
  try {
    const { userId, active } = req.query;

    // Set the userId in req for the controller to use
    if (userId) {
      req.userId = userId;
    }

    // Call the controller function instead of service directly
    const { getAllPricingStrategies } = await import(
      '../controllers/pricingStrategyController.js'
    );
    return getAllPricingStrategies(req, res);
  } catch (err) {
    console.error('Error in GET /active-listings:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2.6) Get all "active" strategies only
//      GET /api/pricing-strategies/active
router.get('/active', async (req, res) => {
  try {
    const strategies = await getActivePricingStrategies();
    return res.status(200).json({
      success: true,
      strategies, // Wrap strategies in the specified format
      rules: [], // Placeholder for rulesData if applicable
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3) Get a single strategy by ID or strategyId
//    GET /api/pricing-strategies/:id
router.get('/:id', async (req, res) => {
  try {
    const strategy = await getPricingStrategy(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    return res.json({ success: true, data: strategy });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 4) Update a strategy
//    PUT /api/pricing-strategies/:id
router.put('/:id', async (req, res) => {
  try {
    const updated = await updatePricingStrategy(req.params.id, req.body);
    return res.json({ success: true, data: updated });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ success: false, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 5) Delete a strategy (only if it has no appliesTo[] entries)
//    DELETE /api/pricing-strategies/:id
router.delete('/:id', async (req, res) => {
  try {
    await deletePricingStrategy(req.params.id);
    return res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ success: false, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 6) Apply a strategy to multiple items
//    POST /api/pricing-strategies/:id/apply
router.post('/:id/apply', async (req, res) => {
  try {
    const items = req.body.items; // should be [{ itemId, sku?, title? }, …]
    const results = await applyStrategyToItemsController(req.params.id, items);
    return res.json({
      success: true,
      message: `Applied to ${results.filter((r) => r.success).length} item(s)`,
      results,
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ success: false, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 6.5) Apply strategies to a specific product/item
//      POST /api/pricing-strategies/products/:itemId
router.post('/products/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { strategyIds, sku = null } = req.body;

    if (
      !strategyIds ||
      !Array.isArray(strategyIds) ||
      strategyIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'strategyIds array is required',
      });
    }

    // Apply strategies using the proven editProduct method
    const results = await applyStrategiesToItem(itemId, strategyIds, sku); // Fixed function name
    const successCount = results.filter((r) => r.success).length;

    // After applying strategies, immediately execute them to update prices
    if (successCount > 0) {
      const { executeStrategiesForItem } = await import(
        '../services/strategyService.js'
      );
      const executeResult = await executeStrategiesForItem(itemId);

      if (executeResult.success) {
        return res.json({
          success: true,
          message: `Applied ${successCount} strategies and updated price for item ${itemId}`,
          results: results.concat(executeResult.results || []),
          priceUpdated: true,
        });
      }
    }

    return res.json({
      success: true,
      message: `Applied ${successCount} of ${strategyIds.length} strategies to item ${itemId}`,
      results,
    });
  } catch (err) {
    console.error('Error applying strategies to product:', err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 6.7) Update/Apply strategy to a specific product/item (PUT method)
//      PUT /api/pricing-strategies/products/:itemId
router.put('/products/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const strategyData = req.body;

    // If the request contains a strategy ID, apply it to the product
    if (strategyData._id || strategyData.strategyId) {
      const strategyId = strategyData._id || strategyData.strategyId;
      const results = await applyStrategiesToItem(
        // Fixed function name
        itemId,
        [strategyId],
        null
      );

      return res.json({
        success: true,
        message: `Strategy applied to item ${itemId}`,
        results,
      });
    }

    // If strategyIds array is provided, apply multiple strategies
    if (strategyData.strategyIds && Array.isArray(strategyData.strategyIds)) {
      const results = await applyStrategiesToItem(
        // Fixed function name
        itemId,
        strategyData.strategyIds,
        strategyData.sku || null
      );
      const successCount = results.filter((r) => r.success).length;

      return res.json({
        success: true,
        message: `Applied ${successCount} of ${strategyData.strategyIds.length} strategies to item ${itemId}`,
        results,
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Strategy ID or strategyIds array is required',
    });
  } catch (err) {
    console.error('Error updating strategies for product:', err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 6.8) Get strategy display information for a product (MOVE THIS BEFORE THE GENERAL GET)
//      GET /api/pricing-strategies/products/:itemId/display
router.get('/products/:itemId/display', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { sku = null } = req.query;


    const { getStrategyDisplayForProduct } = await import(
      '../services/strategyService.js'
    );
    const displayInfo = await getStrategyDisplayForProduct(itemId, sku);



    // Add cache control headers to prevent caching
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });

    return res.json({
      success: true,
      data: displayInfo,
    });
  } catch (err) {
    console.error('Error in GET /products/:itemId/display:', err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
      data: {
        strategy: 'Assign Strategy',
        minPrice: 'Set',
        maxPrice: 'Set',
        hasStrategy: false,
        appliedStrategies: [],
        strategyCount: 0,
      },
    });
  }
});

// 6.12) Get applied strategy from MongoDB price history
//       GET /api/pricing-strategies/products/:itemId/mongo-strategy
router.get('/products/:itemId/mongo-strategy', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { userId } = req.query;

    // Import PriceHistory model
    const { default: PriceHistory } = await import('../models/PriceHistory.js');

    // Find the most recent price history record with a strategy for this item
    const latestRecord = await PriceHistory.findOne({
      itemId: itemId,
      strategyName: { $exists: true, $ne: null },
      ...(userId && { userId: userId }),
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!latestRecord) {
      return res.json({
        success: false,
        message: 'No strategy found in price history for this item',
        data: null,
      });
    }

    // Get the strategy details from the strategy collection
    const { getStrategyById } = await import('../services/strategyService.js');

    // Try to find the strategy by name first
    const { default: PricingStrategy } = await import(
      '../models/PricingStrategy.js'
    );
    const strategy = await PricingStrategy.findOne({
      strategyName: latestRecord.strategyName,
    }).lean();

    if (strategy) {
      return res.json({
        success: true,
        data: {
          strategyName: strategy.strategyName,
          minPrice: strategy.minPrice,
          maxPrice: strategy.maxPrice,
          repricingRule: strategy.repricingRule,
          appliedAt: latestRecord.createdAt,
          lastExecutedPrice: latestRecord.newPrice,
          competitorPrice: latestRecord.competitorLowestPrice,
        },
      });
    } else {
      // Return basic info from price history if strategy not found in collection
      return res.json({
        success: true,
        data: {
          strategyName: latestRecord.strategyName,
          minPrice: null,
          maxPrice: null,
          appliedAt: latestRecord.createdAt,
          lastExecutedPrice: latestRecord.newPrice,
          competitorPrice: latestRecord.competitorLowestPrice,
        },
      });
    }
  } catch (err) {
    console.error(
      'Error in GET /products/:itemId/mongo-strategy:',
      err.message
    );
    return res.status(500).json({
      success: false,
      message: err.message,
      data: null,
    });
  }
});

// 6.6) Get strategies applied to a specific product (MOVE THIS AFTER THE MONGO-STRATEGY ROUTE)
//      GET /api/pricing-strategies/products/:itemId
router.get('/products/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { sku = null } = req.query;
    const strategies = await getStrategiesForItem(itemId, sku);
    return res.json({
      success: true,
      count: strategies.length,
      data: strategies,
    });
  } catch (err) {
    console.error('Error in GET /products/:itemId:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 7) Get strategies that apply to a single item
//    GET /api/pricing-strategies/item/:itemId?sku=<optional>
router.get('/item/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { sku = null } = req.query;
    const strategies = await getStrategiesForItem(itemId, sku);
    return res.json({
      success: true,
      count: strategies.length,
      data: strategies,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 8) Remove a strategy from a specific item (and optional SKU)
//    DELETE /api/pricing-strategies/:id/item/:itemId?sku=<optional>
router.delete('/:id/item/:itemId', async (req, res) => {
  try {
    const { sku = null } = req.query;
    await removeStrategyFromItemController(
      req.params.id,
      req.params.itemId,
      sku
    );
    return res.json({
      success: true,
      message: `Removed strategy from item ${req.params.itemId}`,
    });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ success: false, message: err.message });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// 6.9) Execute all active strategies manually
//      POST /api/pricing-strategies/execute-all
router.post('/execute-all', executeAllStrategiesController);

// 6.10) Execute strategies for a specific item
//       POST /api/pricing-strategies/products/:itemId/execute
router.post('/products/:itemId/execute', async (req, res) => {
  try {
    const { executeStrategiesForItemController } = await import(
      '../controllers/pricingStrategyController.js'
    );
    return executeStrategiesForItemController(req, res);
  } catch (err) {
    console.error('Error in POST /products/:itemId/execute:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 6.11) Force price update for a specific item
//       POST /api/pricing-strategies/products/:itemId/update-price
router.post('/products/:itemId/update-price', async (req, res) => {
  try {
    const { itemId } = req.params;
    const userId = req.user?.id;

    // Get strategies for this item
    const strategies = await getStrategiesForItem(itemId);

    if (!strategies || strategies.length === 0) {
      return res.json({
        success: false,
        message: 'No strategies found for this item',
      });
    }

    // Execute the most recent strategy
    const { executeStrategiesForItem } = await import(
      '../services/strategyService.js'
    );
    const result = await executeStrategiesForItem(itemId);

    // Also try to get competitor price for logging
    try {
      const { getCompetitorPrice } = await import(
        '../services/inventoryService.js'
      );
      const competitorData = await getCompetitorPrice(itemId);

      if (competitorData.success && competitorData.price) {
        const competitorPrice = parseFloat(
          competitorData.price.replace('USD', '')
        );
        const strategy = strategies[0]; // Use first strategy

        let calculatedPrice = competitorPrice;
        if (strategy.repricingRule === 'MATCH_LOWEST') {
          calculatedPrice = competitorPrice;
        }

        // Apply min/max constraints
        if (strategy.minPrice && calculatedPrice < strategy.minPrice) {
          calculatedPrice = strategy.minPrice;
        }
        if (strategy.maxPrice && calculatedPrice > strategy.maxPrice) {
          calculatedPrice = strategy.maxPrice;
        }
      }
    } catch (competitorError) {
      console.error('Error getting competitor price:', competitorError.message);
    }

    return res.json({
      success: true,
      message: `Price update completed for item ${itemId}`,
      data: result,
    });
  } catch (err) {
    console.error('Error in POST /products/:itemId/update-price:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Apply strategy to specific product with listing-specific min/max prices
router.post('/products/:itemId/apply', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { strategyId, minPrice, maxPrice, sku, title } = req.body;

    if (!strategyId) {
      return res.status(400).json({
        success: false,
        message: 'Strategy ID is required',
      });
    }

    const strategy = await PricingStrategy.findById(strategyId);
    if (!strategy) {
      return res.status(404).json({
        success: false,
        message: 'Strategy not found',
      });
    }

    // Apply strategy to item
    await strategy.applyToItem(itemId, sku || null, title || null);

    // Update listing pricing separately
    const { default: Product } = await import('../models/Product.js');
    await Product.findOneAndUpdate(
      { itemId },
      {
        $set: {
          minPrice:
            minPrice !== undefined && minPrice !== null
              ? parseFloat(minPrice)
              : null,
          maxPrice:
            maxPrice !== undefined && maxPrice !== null
              ? parseFloat(maxPrice)
              : null,
        },
      },
      { new: true, upsert: false }
    );

    return res.status(200).json({
      success: true,
      message: 'Strategy applied to product successfully',
      results: [
        {
          success: true,
          itemId,
          minPrice,
          maxPrice,
        },
      ],
    });
  } catch (error) {
    console.error('Error applying strategy to product:', error);
    return res.status(500).json({
      success: false,
      message: 'Error applying strategy to product',
      error: error.message,
    });
  }
});

export default router;
