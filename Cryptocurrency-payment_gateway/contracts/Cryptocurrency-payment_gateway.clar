;; Cryptocurrency Payment Gateway Smart Contract
;; Built with Clarinet for Stacks blockchain

;; Constants
(define-constant contract-owner tx-sender)
(define-constant err-owner-only (err u100))
(define-constant err-insufficient-balance (err u101))
(define-constant err-payment-not-found (err u102))
(define-constant err-payment-already-processed (err u103))
(define-constant err-invalid-amount (err u104))
(define-constant err-merchant-not-registered (err u105))

;; Data Variables
(define-data-var payment-counter uint u0)
(define-data-var platform-fee-rate uint u250) ;; 2.5% fee (250 basis points)

;; Data Maps
(define-map merchants principal 
  {
    name: (string-ascii 64),
    wallet-address: principal,
    is-active: bool,
    total-volume: uint,
    registration-id: uint
  })

(define-map payments uint 
  {
    merchant: principal,
    customer: principal,
    amount: uint,
    fee: uint,
    status: (string-ascii 20),
    product-id: (string-ascii 64),
    timestamp: uint,
    creation-id: uint
  })

(define-map customer-payments principal (list 100 uint))

;; Read-only functions
(define-read-only (get-payment-details (payment-id uint))
  (map-get? payments payment-id))

(define-read-only (get-merchant-info (merchant principal))
  (map-get? merchants merchant))

(define-read-only (get-platform-fee-rate)
  (var-get platform-fee-rate))

(define-read-only (get-payment-counter)
  (var-get payment-counter))

(define-read-only (calculate-fee (amount uint))
  (/ (* amount (var-get platform-fee-rate)) u10000))

(define-read-only (get-customer-payments (customer principal))
  (default-to (list) (map-get? customer-payments customer)))

;; Private functions
(define-private (is-merchant-registered (merchant principal))
  (match (map-get? merchants merchant)
    merchant-data (get is-active merchant-data)
    false))

(define-private (add-payment-to-customer (customer principal) (payment-id uint))
  (let ((current-payments (get-customer-payments customer)))
    (map-set customer-payments customer 
             (unwrap! (as-max-len? (append current-payments payment-id) u100) false))))

;; Public functions

;; Register a new merchant
(define-public (register-merchant (name (string-ascii 64)) (wallet-address principal))
  (let ((registration-id (+ (var-get payment-counter) u1)))
    (begin
      (asserts! (is-eq tx-sender contract-owner) err-owner-only)
      (map-set merchants wallet-address {
        name: name,
        wallet-address: wallet-address,
        is-active: true,
        total-volume: u0,
        registration-id: registration-id
      })
      (var-set payment-counter registration-id)
      (ok registration-id))))

;; Deactivate a merchant
(define-public (deactivate-merchant (merchant principal))
  (begin
    (asserts! (is-eq tx-sender contract-owner) err-owner-only)
    (match (map-get? merchants merchant)
      merchant-data 
        (begin
          (map-set merchants merchant (merge merchant-data { is-active: false }))
          (ok true))
      err-merchant-not-registered)))

;; Create a payment request
(define-public (create-payment (merchant principal) (amount uint) (product-id (string-ascii 64)))
  (let ((payment-id (+ (var-get payment-counter) u1))
        (fee-amount (calculate-fee amount)))
    (begin
      (asserts! (> amount u0) err-invalid-amount)
      (asserts! (is-merchant-registered merchant) err-merchant-not-registered)
      
      ;; Create payment record
      (map-set payments payment-id {
        merchant: merchant,
        customer: tx-sender,
        amount: amount,
        fee: fee-amount,
        status: "pending",
        product-id: product-id,
        timestamp: u0,
        creation-id: payment-id
      })
      
      ;; Update payment counter
      (var-set payment-counter payment-id)
      
      ;; Add to customer's payment history
      (add-payment-to-customer tx-sender payment-id)
      
      (ok payment-id))))

;; Process payment (customer pays)
(define-public (process-payment (payment-id uint))
  (match (map-get? payments payment-id)
    payment-data
      (let ((total-amount (+ (get amount payment-data) (get fee payment-data)))
            (merchant (get merchant payment-data))
            (customer (get customer payment-data)))
        (begin
          (asserts! (is-eq tx-sender customer) (err u106))
          (asserts! (is-eq (get status payment-data) "pending") err-payment-already-processed)
          (asserts! (>= (stx-get-balance tx-sender) total-amount) err-insufficient-balance)
          
          ;; Transfer payment to merchant
          (try! (stx-transfer? (get amount payment-data) tx-sender merchant))
          
          ;; Transfer fee to contract owner (platform)
          (try! (stx-transfer? (get fee payment-data) tx-sender contract-owner))
          
          ;; Update payment status
          (map-set payments payment-id (merge payment-data { status: "completed" }))
          
          ;; Update merchant's total volume
          (match (map-get? merchants merchant)
            merchant-data
              (map-set merchants merchant 
                       (merge merchant-data 
                              { total-volume: (+ (get total-volume merchant-data) (get amount payment-data)) }))
            false)
          
          (ok true)))
    err-payment-not-found))
;; Cancel a payment (only by customer or contract owner)
(define-public (cancel-payment (payment-id uint))
  (match (map-get? payments payment-id)
    payment-data
      (let ((customer (get customer payment-data)))
        (begin
          (asserts! (or (is-eq tx-sender customer) (is-eq tx-sender contract-owner)) (err u107))
          (asserts! (is-eq (get status payment-data) "pending") err-payment-already-processed)
          
          ;; Update payment status
          (map-set payments payment-id (merge payment-data { status: "cancelled" }))
          (ok true)))
    err-payment-not-found))

;; Refund a payment (only by merchant or contract owner)
(define-public (refund-payment (payment-id uint))
  (match (map-get? payments payment-id)
    payment-data
      (let ((merchant (get merchant payment-data))
            (customer (get customer payment-data))
            (amount (get amount payment-data))
            (fee (get fee payment-data)))
        (begin
          (asserts! (or (is-eq tx-sender merchant) (is-eq tx-sender contract-owner)) (err u108))
          (asserts! (is-eq (get status payment-data) "completed") (err u109))
          
          ;; Refund amount to customer
          (try! (stx-transfer? amount merchant customer))
          
          ;; Refund fee to customer (from contract owner)
          (try! (stx-transfer? fee contract-owner customer))
          
          ;; Update payment status
          (map-set payments payment-id (merge payment-data { status: "refunded" }))
          
          ;; Update merchant's total volume
          (match (map-get? merchants merchant)
            merchant-data
              (map-set merchants merchant 
                       (merge merchant-data 
                              { total-volume: (- (get total-volume merchant-data) amount) }))
            false)
          
          (ok true)))
    err-payment-not-found))

;; Update platform fee rate (only contract owner)
(define-public (update-fee-rate (new-rate uint))
  (begin
    (asserts! (is-eq tx-sender contract-owner) err-owner-only)
    (asserts! (<= new-rate u1000) (err u110)) ;; Max 10% fee
    (var-set platform-fee-rate new-rate)
    (ok true)))

;; Get payment statistics for a merchant
(define-read-only (get-merchant-stats (merchant principal))
  (match (map-get? merchants merchant)
    merchant-data
      (ok {
        name: (get name merchant-data),
        total-volume: (get total-volume merchant-data),
        is-active: (get is-active merchant-data),
        registration-id: (get registration-id merchant-data)
      })
    err-merchant-not-registered))

;; Emergency functions (only contract owner)
(define-public (emergency-withdraw (amount uint))
  (begin
    (asserts! (is-eq tx-sender contract-owner) err-owner-only)
    (try! (stx-transfer? amount (as-contract tx-sender) contract-owner))
    (ok true)))