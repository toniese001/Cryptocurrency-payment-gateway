import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Clarinet environment and contract interactions
class MockClarinet {
  constructor() {
    this.accounts = new Map()
    this.contracts = new Map()
    this.blockHeight = 1
    this.currentSender = null
  }

  // Setup test accounts
  setupAccounts() {
    this.accounts.set('deployer', {
      address: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
      balance: 1000000000 // 1000 STX
    })
    this.accounts.set('merchant1', {
      address: 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5',
      balance: 1000000000
    })
    this.accounts.set('customer1', {
      address: 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG',
      balance: 1000000000
    })
    this.accounts.set('customer2', {
      address: 'ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC',
      balance: 500000000 // 500 STX
    })
  }

  // Mock contract call
  callPublic(contractName, functionName, args, sender) {
    this.currentSender = sender
    const contract = this.contracts.get(contractName)
    if (!contract) {
      throw new Error(`Contract ${contractName} not found`)
    }
    return contract[functionName](...args)
  }

  // Mock read-only call
  callReadOnly(contractName, functionName, args) {
    const contract = this.contracts.get(contractName)
    if (!contract) {
      throw new Error(`Contract ${contractName} not found`)
    }
    return contract[functionName](...args)
  }
}

// Mock Payment Gateway Contract
class MockPaymentGateway {
  constructor() {
    this.contractOwner = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
    this.paymentCounter = 0
    this.platformFeeRate = 250 // 2.5%
    this.merchants = new Map()
    this.payments = new Map()
    this.customerPayments = new Map()
    this.accounts = new Map()
  }

  // Initialize with account balances
  setAccountBalance(address, balance) {
    this.accounts.set(address, balance)
  }

  getAccountBalance(address) {
    return this.accounts.get(address) || 0
  }

  // Helper functions
  calculateFee(amount) {
    return Math.floor((amount * this.platformFeeRate) / 10000)
  }

  isMerchantRegistered(merchant) {
    const merchantData = this.merchants.get(merchant)
    return merchantData ? merchantData.isActive : false
  }

  // Contract functions
  registerMerchant(name, walletAddress, sender) {
    if (sender !== this.contractOwner) {
      return { type: 'error', value: 100 } // err-owner-only
    }

    const registrationId = this.paymentCounter + 1
    this.merchants.set(walletAddress, {
      name,
      walletAddress,
      isActive: true,
      totalVolume: 0,
      registrationId
    })
    this.paymentCounter = registrationId
    return { type: 'ok', value: registrationId }
  }

  deactivateMerchant(merchant, sender) {
    if (sender !== this.contractOwner) {
      return { type: 'error', value: 100 } // err-owner-only
    }

    const merchantData = this.merchants.get(merchant)
    if (!merchantData) {
      return { type: 'error', value: 105 } // err-merchant-not-registered
    }

    this.merchants.set(merchant, { ...merchantData, isActive: false })
    return { type: 'ok', value: true }
  }

  createPayment(merchant, amount, productId, sender) {
    if (amount <= 0) {
      return { type: 'error', value: 104 } // err-invalid-amount
    }

    if (!this.isMerchantRegistered(merchant)) {
      return { type: 'error', value: 105 } // err-merchant-not-registered
    }

    const paymentId = this.paymentCounter + 1
    const feeAmount = this.calculateFee(amount)

    this.payments.set(paymentId, {
      merchant,
      customer: sender,
      amount,
      fee: feeAmount,
      status: 'pending',
      productId,
      timestamp: 0,
      creationId: paymentId
    })

    this.paymentCounter = paymentId

    // Add to customer payments
    const customerPayments = this.customerPayments.get(sender) || []
    customerPayments.push(paymentId)
    this.customerPayments.set(sender, customerPayments)

    return { type: 'ok', value: paymentId }
  }

  processPayment(paymentId, sender) {
    const paymentData = this.payments.get(paymentId)
    if (!paymentData) {
      return { type: 'error', value: 102 } // err-payment-not-found
    }

    if (sender !== paymentData.customer) {
      return { type: 'error', value: 106 } // unauthorized
    }

    if (paymentData.status !== 'pending') {
      return { type: 'error', value: 103 } // err-payment-already-processed
    }

    const totalAmount = paymentData.amount + paymentData.fee
    const customerBalance = this.getAccountBalance(sender)

    if (customerBalance < totalAmount) {
      return { type: 'error', value: 101 } // err-insufficient-balance
    }

    // Process transfers
    this.setAccountBalance(sender, customerBalance - totalAmount)
    this.setAccountBalance(paymentData.merchant, 
      this.getAccountBalance(paymentData.merchant) + paymentData.amount)
    this.setAccountBalance(this.contractOwner, 
      this.getAccountBalance(this.contractOwner) + paymentData.fee)

    // Update payment status
    this.payments.set(paymentId, { ...paymentData, status: 'completed' })

    // Update merchant volume
    const merchantData = this.merchants.get(paymentData.merchant)
    if (merchantData) {
      this.merchants.set(paymentData.merchant, {
        ...merchantData,
        totalVolume: merchantData.totalVolume + paymentData.amount
      })
    }

    return { type: 'ok', value: true }
  }

  cancelPayment(paymentId, sender) {
    const paymentData = this.payments.get(paymentId)
    if (!paymentData) {
      return { type: 'error', value: 102 } // err-payment-not-found
    }

    if (sender !== paymentData.customer && sender !== this.contractOwner) {
      return { type: 'error', value: 107 } // unauthorized
    }

    if (paymentData.status !== 'pending') {
      return { type: 'error', value: 103 } // err-payment-already-processed
    }

    this.payments.set(paymentId, { ...paymentData, status: 'cancelled' })
    return { type: 'ok', value: true }
  }

  refundPayment(paymentId, sender) {
    const paymentData = this.payments.get(paymentId)
    if (!paymentData) {
      return { type: 'error', value: 102 } // err-payment-not-found
    }

    if (sender !== paymentData.merchant && sender !== this.contractOwner) {
      return { type: 'error', value: 108 } // unauthorized
    }

    if (paymentData.status !== 'completed') {
      return { type: 'error', value: 109 } // invalid status
    }

    // Process refund transfers
    const merchantBalance = this.getAccountBalance(paymentData.merchant)
    const ownerBalance = this.getAccountBalance(this.contractOwner)
    const customerBalance = this.getAccountBalance(paymentData.customer)

    this.setAccountBalance(paymentData.merchant, merchantBalance - paymentData.amount)
    this.setAccountBalance(this.contractOwner, ownerBalance - paymentData.fee)
    this.setAccountBalance(paymentData.customer, 
      customerBalance + paymentData.amount + paymentData.fee)

    // Update payment status
    this.payments.set(paymentId, { ...paymentData, status: 'refunded' })

    // Update merchant volume
    const merchantData = this.merchants.get(paymentData.merchant)
    if (merchantData) {
      this.merchants.set(paymentData.merchant, {
        ...merchantData,
        totalVolume: merchantData.totalVolume - paymentData.amount
      })
    }

    return { type: 'ok', value: true }
  }

  updateFeeRate(newRate, sender) {
    if (sender !== this.contractOwner) {
      return { type: 'error', value: 100 } // err-owner-only
    }

    if (newRate > 1000) { // Max 10%
      return { type: 'error', value: 110 } // invalid rate
    }

    this.platformFeeRate = newRate
    return { type: 'ok', value: true }
  }

  // Read-only functions
  getPaymentDetails(paymentId) {
    return this.payments.get(paymentId) || null
  }

  getMerchantInfo(merchant) {
    return this.merchants.get(merchant) || null
  }

  getPlatformFeeRate() {
    return this.platformFeeRate
  }

  getPaymentCounter() {
    return this.paymentCounter
  }

  getCustomerPayments(customer) {
    return this.customerPayments.get(customer) || []
  }

  getMerchantStats(merchant) {
    const merchantData = this.merchants.get(merchant)
    if (!merchantData) {
      return { type: 'error', value: 105 } // err-merchant-not-registered
    }

    return {
      type: 'ok',
      value: {
        name: merchantData.name,
        totalVolume: merchantData.totalVolume,
        isActive: merchantData.isActive,
        registrationId: merchantData.registrationId
      }
    }
  }
}

describe('Payment Gateway Smart Contract', () => {
  let clarinet
  let paymentGateway
  let accounts

  beforeEach(() => {
    clarinet = new MockClarinet()
    clarinet.setupAccounts()
    accounts = clarinet.accounts

    paymentGateway = new MockPaymentGateway()
    
    // Setup account balances
    accounts.forEach((account, key) => {
      paymentGateway.setAccountBalance(account.address, account.balance)
    })

    clarinet.contracts.set('payment-gateway', paymentGateway)
  })

  describe('Merchant Registration', () => {
    it('should register a merchant successfully', () => {
      const result = paymentGateway.registerMerchant(
        'Test Coffee Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(1)

      const merchantInfo = paymentGateway.getMerchantInfo(accounts.get('merchant1').address)
      expect(merchantInfo.name).toBe('Test Coffee Shop')
      expect(merchantInfo.isActive).toBe(true)
      expect(merchantInfo.totalVolume).toBe(0)
    })

    it('should fail to register merchant if not contract owner', () => {
      const result = paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('customer1').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(100) // err-owner-only
    })

    it('should deactivate a merchant', () => {
      // First register a merchant
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      // Then deactivate
      const result = paymentGateway.deactivateMerchant(
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)

      const merchantInfo = paymentGateway.getMerchantInfo(accounts.get('merchant1').address)
      expect(merchantInfo.isActive).toBe(false)
    })
  })

  describe('Payment Creation', () => {
    beforeEach(() => {
      // Register a merchant for testing
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )
    })

    it('should create a payment request successfully', () => {
      const result = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        1000000, // 1 STX
        'product-123',
        accounts.get('customer1').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(2) // payment ID

      const paymentDetails = paymentGateway.getPaymentDetails(2)
      expect(paymentDetails.merchant).toBe(accounts.get('merchant1').address)
      expect(paymentDetails.customer).toBe(accounts.get('customer1').address)
      expect(paymentDetails.amount).toBe(1000000)
      expect(paymentDetails.fee).toBe(25000) // 2.5% of 1000000
      expect(paymentDetails.status).toBe('pending')
    })

    it('should fail to create payment with invalid amount', () => {
      const result = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        0,
        'product-123',
        accounts.get('customer1').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(104) // err-invalid-amount
    })

    it('should fail to create payment for unregistered merchant', () => {
      const result = paymentGateway.createPayment(
        accounts.get('customer2').address, // not a registered merchant
        1000000,
        'product-123',
        accounts.get('customer1').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(105) // err-merchant-not-registered
    })
  })

  describe('Payment Processing', () => {
    let paymentId

    beforeEach(() => {
      // Register merchant and create payment
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      const result = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        1000000,
        'product-123',
        accounts.get('customer1').address
      )
      paymentId = result.value
    })

    it('should process payment successfully', () => {
      const initialCustomerBalance = paymentGateway.getAccountBalance(accounts.get('customer1').address)
      const initialMerchantBalance = paymentGateway.getAccountBalance(accounts.get('merchant1').address)

      const result = paymentGateway.processPayment(
        paymentId,
        accounts.get('customer1').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)

      // Check balances
      const finalCustomerBalance = paymentGateway.getAccountBalance(accounts.get('customer1').address)
      const finalMerchantBalance = paymentGateway.getAccountBalance(accounts.get('merchant1').address)

      expect(finalCustomerBalance).toBe(initialCustomerBalance - 1025000) // amount + fee
      expect(finalMerchantBalance).toBe(initialMerchantBalance + 1000000) // amount only

      // Check payment status
      const paymentDetails = paymentGateway.getPaymentDetails(paymentId)
      expect(paymentDetails.status).toBe('completed')
    })

    it('should fail to process payment with insufficient balance', () => {
      // Create payment for customer with insufficient balance
      const result2 = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        600000000, // More than customer2's balance
        'product-456',
        accounts.get('customer2').address
      )

      const result = paymentGateway.processPayment(
        result2.value,
        accounts.get('customer2').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(101) // err-insufficient-balance
    })

    it('should fail to process payment by non-customer', () => {
      const result = paymentGateway.processPayment(
        paymentId,
        accounts.get('customer2').address // Different customer
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(106) // unauthorized
    })
  })

  describe('Payment Cancellation', () => {
    let paymentId

    beforeEach(() => {
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      const result = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        1000000,
        'product-123',
        accounts.get('customer1').address
      )
      paymentId = result.value
    })

    it('should cancel payment by customer', () => {
      const result = paymentGateway.cancelPayment(
        paymentId,
        accounts.get('customer1').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)

      const paymentDetails = paymentGateway.getPaymentDetails(paymentId)
      expect(paymentDetails.status).toBe('cancelled')
    })

    it('should cancel payment by contract owner', () => {
      const result = paymentGateway.cancelPayment(
        paymentId,
        accounts.get('deployer').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)
    })

    it('should fail to cancel payment by unauthorized user', () => {
      const result = paymentGateway.cancelPayment(
        paymentId,
        accounts.get('customer2').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(107) // unauthorized
    })
  })

  describe('Payment Refunds', () => {
    let paymentId

    beforeEach(() => {
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )

      const createResult = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        1000000,
        'product-123',
        accounts.get('customer1').address
      )
      paymentId = createResult.value

      // Process the payment first
      paymentGateway.processPayment(paymentId, accounts.get('customer1').address)
    })

    it('should refund payment by merchant', () => {
      const initialCustomerBalance = paymentGateway.getAccountBalance(accounts.get('customer1').address)

      const result = paymentGateway.refundPayment(
        paymentId,
        accounts.get('merchant1').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)

      // Check customer got full refund (amount + fee)
      const finalCustomerBalance = paymentGateway.getAccountBalance(accounts.get('customer1').address)
      expect(finalCustomerBalance).toBe(initialCustomerBalance + 1025000)

      const paymentDetails = paymentGateway.getPaymentDetails(paymentId)
      expect(paymentDetails.status).toBe('refunded')
    })
  })

  describe('Fee Management', () => {
    it('should update platform fee rate', () => {
      const result = paymentGateway.updateFeeRate(
        500, // 5%
        accounts.get('deployer').address
      )

      expect(result.type).toBe('ok')
      expect(result.value).toBe(true)
      expect(paymentGateway.getPlatformFeeRate()).toBe(500)
    })

    it('should fail to update fee rate if not owner', () => {
      const result = paymentGateway.updateFeeRate(
        500,
        accounts.get('customer1').address
      )

      expect(result.type).toBe('error')
      expect(result.value).toBe(100) // err-owner-only
    })

    it('should calculate fees correctly', () => {
      expect(paymentGateway.calculateFee(1000000)).toBe(25000) // 2.5% of 1M
      expect(paymentGateway.calculateFee(500000)).toBe(12500) // 2.5% of 500K
    })
  })

  describe('Statistics and Queries', () => {
    beforeEach(() => {
      paymentGateway.registerMerchant(
        'Test Shop',
        accounts.get('merchant1').address,
        accounts.get('deployer').address
      )
    })

    it('should get merchant statistics', () => {
      const result = paymentGateway.getMerchantStats(accounts.get('merchant1').address)

      expect(result.type).toBe('ok')
      expect(result.value.name).toBe('Test Shop')
      expect(result.value.totalVolume).toBe(0)
      expect(result.value.isActive).toBe(true)
    })

    it('should track customer payment history', () => {
      const createResult = paymentGateway.createPayment(
        accounts.get('merchant1').address,
        1000000,
        'product-123',
        accounts.get('customer1').address
      )

      const customerPayments = paymentGateway.getCustomerPayments(accounts.get('customer1').address)
      expect(customerPayments).toContain(createResult.value)
    })

    it('should get payment counter', () => {
      expect(paymentGateway.getPaymentCounter()).toBe(1) // After merchant registration
    })
  })
})git 