import express from 'express';
import xml2js from 'xml2js';
import axios from 'axios';
import ebayService from '../services/ebayService.js';
import getEbayListings from '../controllers/ebayController.js';
import fetchProducts from '../services/getInventory.js';
import editProductService from '../services/editProduct.js';
import User from '../models/Users.js';

const router = express.Router();

// ── Helper Functions ────────────────────────────────────────────────────────────

// Parse XML response helper
async function parseXMLResponse(xmlData) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
  return await parser.parseStringPromise(xmlData);
}

// Check if eBay API response is successful
function isEBayResponseSuccessful(result, operationName) {
  const response = result[operationName + 'Response'];
  if (response.Ack !== 'Success' && response.Ack !== 'Warning') {
    const errors = response.Errors;
    const errorMsg = Array.isArray(errors)
      ? errors.map((e) => e.LongMessage || e.ShortMessage).join(', ')
      : errors?.LongMessage || errors?.ShortMessage || 'Unknown error';
    throw new Error(`eBay API Error: ${errorMsg}`);
  }
  return response;
}

// Make eBay XML API call
async function makeEBayAPICall(xmlRequest, callName) {
  const response = await axios({
    method: 'post',
    url: 'https://api.ebay.com/ws/api.dll',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1155',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0', // US site
    },
    data: xmlRequest,
  });
  return response.data;
}

// ── Routes ──────────────────────────────────────────────────────────────────────

router.get('/active-listings', fetchProducts.getActiveListings);

/**
 * Get competitor prices for a specific item
 */
router.get('/competitor-prices/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required in query parameters',
      });
    }

    // Get user's eBay token
    const user = await User.findById(userId);
    if (!user || !user.ebay.accessToken) {
      return res.status(400).json({
        success: false,
        message: 'No eBay credentials found for this user',
      });
    }

    const oauthToken = user.ebay.accessToken;
    const appId = process.env.CLIENT_ID; // Browse API

    if (!oauthToken) {
      return res
        .status(400)
        .json({ success: false, message: 'eBay auth token is required' });
    }

    // 1) GetItem request (Trading API)
    const getItemXml = `
      <?xml version="1.0" encoding="utf-8"?>
      <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${oauthToken}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <DetailLevel>ReturnAll</DetailLevel>
        <IncludeItemSpecifics>true</IncludeItemSpecifics>
      </GetItemRequest>
    `;
    const getItemResponse = await makeEBayAPICall(getItemXml, 'GetItem');
    const parsedItem = await parseXMLResponse(getItemResponse);
    const itemResult = isEBayResponseSuccessful(parsedItem, 'GetItem');
    const item = itemResult.Item;
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    // Extract title & category for Browse call
    const title = item.Title || '';
    const categoryId = item.PrimaryCategory?.CategoryID || '';

    // 2) Browse API competitor prices
    const query = new URLSearchParams({
      q: title,
      category_ids: categoryId,
      limit: 20,
      sort: 'price',
    });
    const browseResponse = await axios.get(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${oauthToken}`, // Fixed to use oauthToken
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const items = browseResponse.data.itemSummaries || [];
    const competitorPrices = items
      .filter((i) => i.itemId !== itemId)
      .map((i) => {
        const price = parseFloat(i.price.value);
        const shipping = parseFloat(
          i.shippingOptions?.[0]?.shippingCost?.value || '0'
        );
        return +(price + shipping).toFixed(2);
      })
      .filter((p) => !isNaN(p) && p > 0);

    res.json({
      success: true,
      itemId,
      itemTitle: item.Title,
      competitorPrices: {
        allData: items.map((i) => ({
          id: i.itemId,
          title: i.title,
          price: parseFloat(i.price.value),
          shipping:
            parseFloat(i.shippingOptions?.[0]?.shippingCost?.value || '0') || 0,
          imageurl: i.thumbnailImages[0]?.imageUrl || '',
          seller: i.seller?.username,
          condition: i.condition,
          productUrl: i.itemWebUrl,
          locale: i.itemLocation?.country,
        })),
        lowestPrice:
          competitorPrices.length > 0 ? Math.min(...competitorPrices) : 0,
        allPrices: competitorPrices,
      },
    });
  } catch (error) {
    console.error('Error fetching competitor prices:', error);
    if (error.message.includes('rate limit')) {
      return res.status(429).json({
        success: false,
        message: 'eBay API rate limit exceeded. Try again later.',
        error: error.message,
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Get active listings via feed
 */
router.get('/active-listingsviaFeed', fetchProducts.getActiveListingsViaFeed);

/**
 * Get item variations for a specific item
 */
router.get('/item-variations/:itemId', editProductService.getItemVariations);

/**
 * Edit variation price for a specific variation
 */
router.post('/edit-variation-price', editProductService.editVariationPrice);

/**
 * Edit all variations prices for an item
 */
router.post(
  '/edit-all-variations-price',
  editProductService.editAllVariationsPrices
);

/**
 * Get item details by ID
 */
router.get('/item/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required in query parameters',
      });
    }

    // Get user's eBay token
    const user = await User.findById(userId);
    if (!user || !user.ebay.accessToken) {
      return res.status(400).json({
        success: false,
        message: 'No eBay credentials found for this user',
      });
    }

    const authToken = user.ebay.accessToken;

    const xmlRequest = `
      <?xml version="1.0" encoding="utf-8"?>
      <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${authToken}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <DetailLevel>ReturnAll</DetailLevel>
        <IncludeItemSpecifics>true</IncludeItemSpecifics>
      </GetItemRequest>
    `;

    const xmlResponse = await makeEBayAPICall(xmlRequest, 'GetItem');
    const result = await parseXMLResponse(xmlResponse);
    const response = isEBayResponseSuccessful(result, 'GetItem');

    const item = response.Item;
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    res.json({
      success: true,
      itemId,
      item: {
        title: item.Title,
        currentPrice: item.StartPrice?.Value || item.StartPrice?.__value__ || 0,
        currency: item.StartPrice?.__attributes__?.currencyID || 'USD',
        listingType: item.ListingType,
        condition: item.ConditionDisplayName,
        category: item.PrimaryCategory,
        itemSpecifics: item.ItemSpecifics?.NameValueList || [],
        description: item.Description,
        location: item.Location,
        startTime: item.StartTime,
        endTime: item.EndTime,
        listingStatus: item.SellingStatus?.ListingStatus,
      },
    });
  } catch (error) {
    console.error('eBay Get Item Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
