# MachineWatch

Watching the Lamassu Bitcoin Vending Machine for transactions, and 
manage notifications.

## Method of operations

Lamassu is (currently) using a single address for sourcing transactions
going in or out of the machine. The wallet is on Blockchain.info


## Actionable

- [X] move to Bitpay price API (instead of scraping)
- [X] correctly identify incoming and outgoing transactions
- [X] account for number of spendable coins
- [X] write incoming results into Google Spreadsheet for accounting

## Notes

To add the certificate into the environment variable: need to run
`heroku config:set PEM_KEY="`cat /path/to/your_key.pem`"`
