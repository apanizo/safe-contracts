const utils = require('./utils')
const solc = require('solc')

const GnosisSafe = artifacts.require("./GnosisSafe.sol");
const CreateAndAddExtension = artifacts.require("./libraries/CreateAndAddExtension.sol");
const ProxyFactory = artifacts.require("./ProxyFactory.sol");
const DailyLimitExtensionWithSignature = artifacts.require("./extensions/DailyLimitExtensionWithSignature.sol");


contract('DailyLimitExtensionWithSignature', function(accounts) {

    let gnosisSafe
    let dailyLimitExtension
    let lw

    const CALL = 0

    let generateSignature = async function(to, value, data) {
      let nonce = await dailyLimitExtension.nonce()
      let transactionHash = await dailyLimitExtension.getTransactionHash(to, value, data, nonce)
      return utils.signTransaction(lw, [lw.accounts[0]], transactionHash)
    }

    beforeEach(async function () {
        // Create lightwallet
        lw = await utils.createLightwallet()
        // Create Master Copies
        let proxyFactory = await ProxyFactory.new()
        let createAndAddExtension = await CreateAndAddExtension.new()
        let gnosisSafeMasterCopy = await GnosisSafe.new()
        // Initialize safe master copy
        gnosisSafeMasterCopy.setup([accounts[0]], 1, 0, 0)
        let dailyLimitExtensionMasterCopy = await DailyLimitExtensionWithSignature.new()
        // Initialize extension master copy
        dailyLimitExtensionMasterCopy.setup([], [])
        // Create Gnosis Safe and Daily Limit Extension in one transactions
        let extensionData = await dailyLimitExtensionMasterCopy.contract.setup.getData([0], [100])
        let proxyFactoryData = await proxyFactory.contract.createProxy.getData(dailyLimitExtensionMasterCopy.address, extensionData)
        let createAndAddExtensionData = createAndAddExtension.contract.createAndAddExtension.getData(proxyFactory.address, proxyFactoryData)
        let gnosisSafeData = await gnosisSafeMasterCopy.contract.setup.getData([lw.accounts[0], lw.accounts[1], accounts[0]], 2, createAndAddExtension.address, createAndAddExtensionData)
        gnosisSafe = utils.getParamFromTxEvent(
            await proxyFactory.createProxy(gnosisSafeMasterCopy.address, gnosisSafeData),
            'ProxyCreation', 'proxy', proxyFactory.address, GnosisSafe, 'create Gnosis Safe and Daily Limit Extension',
        )
        let extensions = await gnosisSafe.getExtensions()
        dailyLimitExtension = DailyLimitExtensionWithSignature.at(extensions[0])
        assert.equal(await dailyLimitExtension.getGnosisSafe.call(), gnosisSafe.address)
    })

    it('should withdraw daily limit', async () => {
        // Deposit 1 eth
        await web3.eth.sendTransaction({from: accounts[0], to: gnosisSafe.address, value: web3.toWei(1, 'ether')})
        assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1, 'ether'));
        // Withdraw daily limit
        let sigs = await generateSignature(accounts[0], 50, 0)
        utils.logGasUsage(
            'executeExtension withdraw daily limit',
            await dailyLimitExtension.executeDailyLimitWithSignature(
                accounts[0], 50, 0, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            )
        )

        // Cannot reuse same signature
        await utils.assertRejects(
            dailyLimitExtension.executeDailyLimitWithSignature(
                accounts[0], 50, 0, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            ),
            "Invalid signature"
        )

        sigs = await generateSignature(accounts[0], 50, 0)
        utils.logGasUsage(
            'executeExtension withdraw daily limit 2nd time',
            await dailyLimitExtension.executeDailyLimitWithSignature(
                accounts[0], 50, 0, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            )
        )
        assert.equal(await web3.eth.getBalance(gnosisSafe.address).toNumber(), web3.toWei(1, 'ether') - 100);

        sigs = await generateSignature(accounts[0], 50, 0)
        // Third withdrawal will fail
        await utils.assertRejects(
            dailyLimitExtension.executeDailyLimitWithSignature(
                accounts[0], 50, 0, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            ),
            "Daily limit exceeded"
        )
    })

    it('should change daily limit', async () => {
        // Change daily limit
        let dailyLimit = await dailyLimitExtension.dailyLimits(0)
        assert.equal(dailyLimit[0], 100);
        let data = await dailyLimitExtension.contract.changeDailyLimit.getData(0, 200)

        let nonce = await gnosisSafe.nonce()
        let transactionHash = await gnosisSafe.getTransactionHash(dailyLimitExtension.address, 0, data, CALL, nonce)
        let sigs = utils.signTransaction(lw, [lw.accounts[0], lw.accounts[1]], transactionHash)

        utils.logGasUsage(
            'executeTransaction change daily limit',
            await gnosisSafe.executeTransaction(
                dailyLimitExtension.address, 0, data, CALL, sigs.sigV, sigs.sigR, sigs.sigS
            )
        )
        dailyLimit = await dailyLimitExtension.dailyLimits(0)
        assert.equal(dailyLimit[0], 200);
    })

    it('should withdraw daily limit for an ERC20 token', async () => {
        // Create fake token
        let source = `
        contract TestToken {
            mapping (address => uint) public balances;
            function TestToken() {
                balances[msg.sender] = 100;
            }
            function transfer(address to, uint value) public returns (bool) {
                balances[msg.sender] -= value;
                balances[to] += value;
            }
        }`
        let output = await solc.compile(source, 0);
        // Create test token contract
        let contractInterface = JSON.parse(output.contracts[':TestToken']['interface'])
        let contractBytecode = '0x' + output.contracts[':TestToken']['bytecode']
        let transactionHash = await web3.eth.sendTransaction({from: accounts[0], data: contractBytecode, gas: 4000000})
        let receipt = web3.eth.getTransactionReceipt(transactionHash);
        const TestToken = web3.eth.contract(contractInterface)
        let testToken = TestToken.at(receipt.contractAddress)
        // Add test token to daily limit extension
        let data = await dailyLimitExtension.contract.changeDailyLimit.getData(testToken.address, 20)
        let nonce = await gnosisSafe.nonce()
        transactionHash = await gnosisSafe.getTransactionHash(dailyLimitExtension.address, 0, data, CALL, nonce)
        let sigs = utils.signTransaction(lw, [lw.accounts[0], lw.accounts[1]], transactionHash)
        await gnosisSafe.executeTransaction(dailyLimitExtension.address, 0, data, CALL, sigs.sigV, sigs.sigR, sigs.sigS)
        // Transfer 100 tokens to Safe
        assert.equal(await testToken.balances(gnosisSafe.address), 0);
        await testToken.transfer(gnosisSafe.address, 100, {from: accounts[0]})
        assert.equal(await testToken.balances(gnosisSafe.address), 100);
        // Withdraw daily limit
        data = await testToken.transfer.getData(accounts[0], 10)

        // First withdrawal
        sigs = await generateSignature(testToken.address, 0, data)
        utils.logGasUsage(
            'executeExtension withdraw daily limit for ERC20 token',
            await dailyLimitExtension.executeDailyLimitWithSignature(
                testToken.address, 0, data, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            )
        )
        assert.equal(await testToken.balances(gnosisSafe.address), 90);
        assert.equal(await testToken.balances(accounts[0]), 10);

        // Cannot reuse same signature
        await utils.assertRejects(
            dailyLimitExtension.executeDailyLimitWithSignature(
                testToken.address, 0, data, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            ),
            "Invalid signature"
        )

        // Second withdrawal
        sigs = await generateSignature(testToken.address, 0, data)
        utils.logGasUsage(
            'executeExtension withdraw daily limit for ERC20 token 2nd time',
            await dailyLimitExtension.executeDailyLimitWithSignature(
                testToken.address, 0, data, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}
            )
        )
        assert.equal(await testToken.balances(gnosisSafe.address), 80);
        assert.equal(await testToken.balances(accounts[0]), 20);

        // Third withdrawal will fail
        sigs = await generateSignature(testToken.address, 0, data)
        await utils.assertRejects(
            dailyLimitExtension.executeDailyLimitWithSignature(testToken.address, 0, data, sigs.sigV[0], sigs.sigR[0], sigs.sigS[0], {from: accounts[9]}),
            "Daily limit exceeded for ERC20 token"
        )
        // Balances didn't change
        assert.equal(await testToken.balances(gnosisSafe.address), 80);
        assert.equal(await testToken.balances(accounts[0]), 20);
    })
});